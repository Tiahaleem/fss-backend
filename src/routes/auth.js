const { loginLimiter, signupLimiter, verifyLimiter, resendLimiter } = require("../rateLimiters");
// =========================
// AUTH API
// =========================
// Mirrors auth.js client-side, but for real this time:
//   - Passwords are bcrypt-hashed, never stored or compared as plain text
//   - Verification codes are checked server-side (not shown to the
//     frontend to display on-screen, the way the demo did)
//   - Login returns a signed JWT the frontend stores and sends back
//     on future requests, instead of a browser-only "session"
//
// One thing still missing on purpose: actually EMAILING the
// verification code. That needs an email service (Resend, matching
// what was already planned) — until that's wired up, this returns
// the code directly in the signup response so the flow can still be
// tested end-to-end. That return value gets deleted the moment email
// sending exists — search for "REMOVE ONCE EMAIL IS WIRED UP" below.

const express = require("express");
const router = express.Router();
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { OAuth2Client } = require("google-auth-library");
const pool = require("../db");
const { requireAuth } = require("../middleware/requireAuth");
const { sendVerificationEmail } = require("../email");

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function generateCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

function signToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: "7d" }
    );
}

function toClientShape(user) {
    return { id: user.id, name: user.name, email: user.email, role: user.role };
}

// =========================
// POST /api/auth/signup
// =========================
router.post("/signup", signupLimiter, async (req, res) => {
    const client = await pool.connect();

    try {
        const { name, email, password } = req.body;

        if (!name || !email || !password) {
            return res.status(400).json({ error: "Name, email, and password are all required." });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: "Password must be at least 8 characters." });
        }

        const existing = await client.query("SELECT id FROM users WHERE email = $1", [email.toLowerCase()]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: "An account with that email already exists." });
        }

        await client.query("BEGIN");

        const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);

        const userResult = await client.query(
            `INSERT INTO users (name, email, password_hash, role, email_verified)
             VALUES ($1, $2, $3, 'customer', false)
             RETURNING *`,
            [name, email.toLowerCase(), passwordHash]
        );

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        await client.query(
            `INSERT INTO verification_codes (user_id, email, code, purpose, expires_at)
             VALUES ($1, $2, $3, 'signup', $4)`,
            [userResult.rows[0].id, email.toLowerCase(), code, expiresAt]
        );

        await client.query("COMMIT");

        // Try to actually email the code — only fall back to showing
        // it in the response if that fails, so a working email
        // service means the code is never exposed to anyone but the
        // real inbox it was sent to.
        const emailResult = await sendVerificationEmail(email.toLowerCase(), code);

        res.status(201).json({
            message: emailResult.success
                ? "Account created. Check your email for a verification code."
                : "Account created, but the verification email couldn't be sent — here's your code instead.",
            userId: userResult.rows[0].id,
            ...(emailResult.success ? {} : { _devCode: code, _emailError: emailResult.error })
        });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("POST /api/auth/signup failed:", err);
        res.status(500).json({ error: "Couldn't create that account." });
    } finally {
        client.release();
    }
});

// =========================
// POST /api/auth/resend-code
// =========================
router.post("/resend-code", resendLimiter, async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({ error: "Email is required." });
        }

        const userResult = await pool.query(
            "SELECT id, email_verified FROM users WHERE email = $1",
            [email.toLowerCase()]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: "No pending signup found for that email." });
        }

        if (userResult.rows[0].email_verified) {
            return res.status(400).json({ error: "That account is already verified — try signing in." });
        }

        const code = generateCode();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

        await pool.query(
            `INSERT INTO verification_codes (user_id, email, code, purpose, expires_at)
             VALUES ($1, $2, $3, 'signup', $4)`,
            [userResult.rows[0].id, email.toLowerCase(), code, expiresAt]
        );

        const emailResult = await sendVerificationEmail(email.toLowerCase(), code);

        res.json({
            message: emailResult.success ? "New code sent to your email." : "Couldn't send the email — here's your code instead.",
            ...(emailResult.success ? {} : { _devCode: code, _emailError: emailResult.error })
        });
    } catch (err) {
        console.error("POST /api/auth/resend-code failed:", err);
        res.status(500).json({ error: "Couldn't resend the code." });
    }
});

// =========================
// POST /api/auth/verify
// =========================
router.post("/verify", verifyLimiter, async (req, res) => {
    try {
        const { email, code } = req.body;

        if (!email || !code) {
            return res.status(400).json({ error: "Email and code are both required." });
        }

        const result = await pool.query(
            `SELECT * FROM verification_codes
             WHERE email = $1 AND code = $2 AND purpose = 'signup' AND used_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
            [email.toLowerCase(), code]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ error: "Incorrect code." });
        }

        const verification = result.rows[0];

        if (new Date(verification.expires_at) < new Date()) {
            return res.status(400).json({ error: "That code has expired. Request a new one." });
        }

        await pool.query("UPDATE verification_codes SET used_at = now() WHERE id = $1", [verification.id]);
        const userResult = await pool.query(
            "UPDATE users SET email_verified = true WHERE id = $1 RETURNING *",
            [verification.user_id]
        );

        const user = userResult.rows[0];
        const token = signToken(user);

        res.json({ token, user: toClientShape(user) });
    } catch (err) {
        console.error("POST /api/auth/verify failed:", err);
        res.status(500).json({ error: "Couldn't verify that code." });
    }
});

// =========================
// POST /api/auth/login
// =========================
router.post("/login", loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "Email and password are both required." });
        }

        const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);

        if (result.rows.length === 0) {
            return res.status(401).json({ error: "Incorrect email or password." });
        }

        const user = result.rows[0];

        if (!user.password_hash) {
            return res.status(401).json({ error: "This account uses Google Sign-In — use the Google button instead of a password." });
        }

        const passwordMatches = await bcrypt.compare(password, user.password_hash);

        if (!passwordMatches) {
            return res.status(401).json({ error: "Incorrect email or password." });
        }

        const token = signToken(user);
        res.json({ token, user: toClientShape(user) });
    } catch (err) {
        console.error("POST /api/auth/login failed:", err);
        res.status(500).json({ error: "Couldn't sign in." });
    }
});

// =========================
// GET /api/auth/me
// =========================
// Lets the frontend check "is my stored login token still valid?"
// and get fresh user info — used by admin.js's session guard instead
// of just trusting whatever was cached locally.
router.get("/me", requireAuth, async (req, res) => {
    try {
        const result = await pool.query("SELECT id, name, email, role FROM users WHERE id = $1", [req.user.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Account not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("GET /api/auth/me failed:", err);
        res.status(500).json({ error: "Couldn't load account info." });
    }
});

// =========================
// PUT /api/auth/me
// =========================
// Works for ANY signed-in user — customer or admin, whichever token
// was sent. This is deliberately just "update my own account", not
// an admin-only endpoint — an admin uses this for their own profile
// exactly the same way a customer does for theirs.
router.put("/me", requireAuth, async (req, res) => {
    const client = await pool.connect();

    try {
        const { name, email, currentPassword, newPassword } = req.body;

        if (!name || !email) {
            return res.status(400).json({ error: "Name and email can't be empty." });
        }

        const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailPattern.test(email)) {
            return res.status(400).json({ error: "Please enter a valid email address." });
        }

        const emailTaken = await client.query(
            "SELECT id FROM users WHERE email = $1 AND id != $2",
            [email.toLowerCase(), req.user.id]
        );

        if (emailTaken.rows.length > 0) {
            return res.status(409).json({ error: "That email is already in use by another account." });
        }

        const currentUserResult = await client.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
        let passwordHashToSave = currentUserResult.rows[0].password_hash;

        const wantsPasswordChange = currentPassword || newPassword;

        if (wantsPasswordChange) {
            const passwordMatches = await bcrypt.compare(currentPassword || "", passwordHashToSave);

            if (!passwordMatches) {
                return res.status(401).json({ error: "Current password is incorrect." });
            }

            if (!newPassword || newPassword.length < 8) {
                return res.status(400).json({ error: "New password must be at least 8 characters." });
            }

            passwordHashToSave = await bcrypt.hash(newPassword, SALT_ROUNDS);
        }

        const updateResult = await client.query(
            `UPDATE users SET name = $1, email = $2, password_hash = $3, updated_at = now()
             WHERE id = $4
             RETURNING *`,
            [name, email.toLowerCase(), passwordHashToSave, req.user.id]
        );

        res.json(toClientShape(updateResult.rows[0]));
    } catch (err) {
        console.error("PUT /api/auth/me failed:", err);
        res.status(500).json({ error: "Couldn't update your account." });
    } finally {
        client.release();
    }
});

// =========================
// POST /api/auth/google
// =========================
// The frontend sends the ID token Google's own Sign-In button
// produced. This verifies it DIRECTLY with Google's servers — never
// trusting the token's contents at face value, since anyone could
// send a fake one otherwise. Only after Google itself confirms the
// token is genuine does this look at the email/name inside it.
router.post("/google", async (req, res) => {
    try {
        const { credential } = req.body;

        if (!credential) {
            return res.status(400).json({ error: "Missing Google credential." });
        }

        const ticket = await googleClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        if (!payload.email_verified) {
            return res.status(401).json({ error: "Your Google email isn't verified." });
        }

        const email = payload.email.toLowerCase();
        const name = payload.name || email.split("@")[0];
        const googleId = payload.sub;

        const existing = await pool.query("SELECT * FROM users WHERE email = $1", [email]);
        let user;

        if (existing.rows.length > 0) {
            // Already have an account with this email — sign them in.
            // Also mark it verified and link the Google ID, since
            // Google just re-confirmed this email is real and theirs.
            const updateResult = await pool.query(
                "UPDATE users SET email_verified = true, google_id = $1 WHERE id = $2 RETURNING *",
                [googleId, existing.rows[0].id]
            );
            user = updateResult.rows[0];
        } else {
            // Brand new account — no password, since Google is doing
            // the authenticating from now on for this account.
            const insertResult = await pool.query(
                `INSERT INTO users (name, email, password_hash, google_id, role, email_verified)
                 VALUES ($1, $2, NULL, $3, 'customer', true)
                 RETURNING *`,
                [name, email, googleId]
            );
            user = insertResult.rows[0];
        }

        const token = signToken(user);
        res.json({ token, user: toClientShape(user) });
    } catch (err) {
        console.error("POST /api/auth/google failed:", err.message);
        res.status(401).json({ error: "Couldn't verify that Google sign-in." });
    }
});

module.exports = router;
