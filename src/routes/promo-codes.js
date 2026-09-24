const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// PROMO CODES API
// =========================
// The discount is always computed and validated SERVER-SIDE — a
// customer's browser only ever sends the code text itself, never a
// discount amount. This is the same trust model as everything else
// in payments: nothing the client claims about money is ever trusted
// directly.

const express = require("express");
const router = express.Router();
const pool = require("../db");

function toClientShape(row) {
    return {
        id: row.id,
        code: row.code,
        discountType: row.discount_type,
        discountValue: row.discount_value,
        maxUses: row.max_uses,
        timesUsed: row.times_used,
        expiresAt: row.expires_at,
        status: row.status
    };
}

// Shared by both the public "preview my discount" endpoint below AND
// payments.js's real checkout flow — one place decides what counts
// as a valid, usable code, so the two can never quietly disagree.
async function validatePromoCode(code, amountKobo) {
    if (!code) return { valid: false, error: "No code provided." };

    const result = await pool.query(
        "SELECT * FROM promo_codes WHERE code = $1",
        [code.trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
        return { valid: false, error: "That promo code doesn't exist." };
    }

    const promo = result.rows[0];

    if (promo.status !== "active") {
        return { valid: false, error: "That promo code is no longer active." };
    }

    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
        return { valid: false, error: "That promo code has expired." };
    }

    if (promo.max_uses !== null && promo.times_used >= promo.max_uses) {
        return { valid: false, error: "That promo code has reached its usage limit." };
    }

    const discountKobo = promo.discount_type === "percentage"
        ? Math.round(amountKobo * (promo.discount_value / 100))
        : Math.min(promo.discount_value, amountKobo); // never discount below zero

    return {
        valid: true,
        promoId: promo.id,
        discountKobo,
        finalAmountKobo: amountKobo - discountKobo
    };
}

// GET /api/promo-codes — admin list
router.get("/", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM promo_codes ORDER BY created_at DESC");
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/promo-codes failed:", err);
        res.status(500).json({ error: "Couldn't load promo codes." });
    }
});

// GET /api/promo-codes/validate?code=WELCOME10&amountKobo=2450000 — public,
// lets the checkout page preview a discount before committing to payment.
router.get("/validate", async (req, res) => {
    try {
        const { code, amountKobo } = req.query;

        if (!code || !amountKobo || isNaN(Number(amountKobo))) {
            return res.status(400).json({ error: "code and amountKobo are required." });
        }

        const result = await validatePromoCode(code, Number(amountKobo));

        if (!result.valid) {
            return res.status(400).json({ error: result.error });
        }

        res.json({
            valid: true,
            discountKobo: result.discountKobo,
            finalAmountKobo: result.finalAmountKobo
        });
    } catch (err) {
        console.error("GET /api/promo-codes/validate failed:", err);
        res.status(500).json({ error: "Couldn't check that promo code right now." });
    }
});

// POST /api/promo-codes — create a new code
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { code, discountType, discountValue, maxUses, expiresAt, status } = req.body;

        if (!code || !discountType || !discountValue) {
            return res.status(400).json({ error: "code, discountType, and discountValue are all required." });
        }

        if (!["percentage", "fixed"].includes(discountType)) {
            return res.status(400).json({ error: "discountType must be 'percentage' or 'fixed'." });
        }

        if (discountType === "percentage" && (discountValue < 1 || discountValue > 100)) {
            return res.status(400).json({ error: "A percentage discount must be between 1 and 100." });
        }

        const result = await pool.query(
            `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, expires_at, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [code.trim().toUpperCase(), discountType, discountValue, maxUses || null, expiresAt || null, status || "active"]
        );

        res.status(201).json(toClientShape(result.rows[0]));
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "That code already exists." });
        }
        console.error("POST /api/promo-codes failed:", err);
        res.status(500).json({ error: "Couldn't create that promo code." });
    }
});

// PUT /api/promo-codes/:id — update an existing code
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { code, discountType, discountValue, maxUses, expiresAt, status } = req.body;

        if (discountType === "percentage" && (discountValue < 1 || discountValue > 100)) {
            return res.status(400).json({ error: "A percentage discount must be between 1 and 100." });
        }

        const result = await pool.query(
            `UPDATE promo_codes
             SET code = $1, discount_type = $2, discount_value = $3,
                 max_uses = $4, expires_at = $5, status = $6
             WHERE id = $7
             RETURNING *`,
            [code.trim().toUpperCase(), discountType, discountValue, maxUses || null, expiresAt || null, status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Promo code not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "That code already exists." });
        }
        console.error("PUT /api/promo-codes/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that promo code." });
    }
});

// DELETE /api/promo-codes/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM promo_codes WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Promo code not found." });
        }

        res.status(204).send();
    } catch (err) {
        console.error("DELETE /api/promo-codes/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that promo code." });
    }
});

module.exports = router;
module.exports.validatePromoCode = validatePromoCode;
