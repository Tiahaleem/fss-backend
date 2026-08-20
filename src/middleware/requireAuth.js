// =========================
// AUTH MIDDLEWARE
// =========================
// Checks for a valid JWT in the Authorization header
// (format: "Authorization: Bearer <token>"). If valid, attaches the
// logged-in user's info to req.user for the rest of the request to
// use. If missing/invalid, stops the request with a 401 before it
// reaches the actual route handler.
//
// Used on routes that need to know WHO is asking — e.g. "give me my
// own bookings" (my-bookings.html) needs this; "list active routes"
// (route.html, public) does not.

const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({ error: "You must be signed in." });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { id, email, role }
        next();
    } catch (err) {
        return res.status(401).json({ error: "Your session has expired. Please sign in again." });
    }
}

// Same as above, but also requires role = 'admin' — for protecting
// the admin CRUD endpoints (admin-routes.html, etc.) once they call
// this API instead of localStorage.
function requireAdmin(req, res, next) {
    requireAuth(req, res, () => {
        if (req.user.role !== "admin") {
            return res.status(403).json({ error: "Admin access required." });
        }
        next();
    });
}

// Same idea, but doesn't fail if there's no token — just leaves
// req.user as null. Used on endpoints that work for both guests and
// signed-in customers (like creating a booking), where being signed
// in changes what gets recorded but isn't required to proceed.
function optionalAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        req.user = null;
        return next();
    }

    try {
        req.user = jwt.verify(authHeader.split(" ")[1], process.env.JWT_SECRET);
    } catch (err) {
        req.user = null;
    }

    next();
}

module.exports = { requireAuth, requireAdmin, optionalAuth };