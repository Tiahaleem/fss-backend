// =========================
// ROUTES API
// (the Route resource — Lagos → Abuja pricing, etc. —
//  not to be confused with "Express routes", which is what
//  this file itself technically is. Naming collision, sorry.)
// =========================
// Mirrors exactly what admin-routes.js does client-side:
// GET all, GET one, POST (create), PUT (update), DELETE.
//
// Price handling: the frontend works in plain Naira (e.g. 24500).
// The database stores price_kobo (24500 * 100) to avoid floating
// point rounding bugs. This file converts between the two at the
// edges, so the frontend never has to know kobo exists.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdmin } = require("../middleware/requireAuth");

function toNaira(row) {
    return {
        id: row.id,
        from: row.from_city,
        to: row.to_city,
        distance: row.distance_km,
        duration: row.duration,
        price: Math.round(row.price_kobo / 100),
        status: row.status
    };
}

// GET /api/routes — list every route (optionally ?status=active)
router.get("/", async (req, res) => {
    try {
        const { status } = req.query;

        const result = status
            ? await pool.query("SELECT * FROM routes WHERE status = $1 ORDER BY from_city, to_city", [status])
            : await pool.query("SELECT * FROM routes ORDER BY from_city, to_city");

        res.json(result.rows.map(toNaira));
    } catch (err) {
        console.error("GET /api/routes failed:", err);
        res.status(500).json({ error: "Couldn't load routes." });
    }
});

// GET /api/routes/:id — one specific route
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM routes WHERE id = $1", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Route not found." });
        }

        res.json(toNaira(result.rows[0]));
    } catch (err) {
        console.error("GET /api/routes/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that route." });
    }
});

// POST /api/routes — create a new route
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { from, to, distance, duration, price, status } = req.body;

        if (!from || !to || !distance || !duration || !price) {
            return res.status(400).json({ error: "from, to, distance, duration, and price are all required." });
        }

        const result = await pool.query(
            `INSERT INTO routes (from_city, to_city, distance_km, duration, price_kobo, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [from, to, distance, duration, Math.round(price * 100), status || "active"]
        );

        res.status(201).json(toNaira(result.rows[0]));
    } catch (err) {
        if (err.code === "23505") {
            // Unique constraint on (from_city, to_city) — see schema.sql
            return res.status(409).json({ error: "A route between these two cities already exists." });
        }
        console.error("POST /api/routes failed:", err);
        res.status(500).json({ error: "Couldn't create that route." });
    }
});

// PUT /api/routes/:id — update an existing route
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { from, to, distance, duration, price, status } = req.body;

        const result = await pool.query(
            `UPDATE routes
             SET from_city = $1, to_city = $2, distance_km = $3, duration = $4,
                 price_kobo = $5, status = $6, updated_at = now()
             WHERE id = $7
             RETURNING *`,
            [from, to, distance, duration, Math.round(price * 100), status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Route not found." });
        }

        res.json(toNaira(result.rows[0]));
    } catch (err) {
        console.error("PUT /api/routes/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that route." });
    }
});

// DELETE /api/routes/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM routes WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Route not found." });
        }

        res.status(204).send();
    } catch (err) {
        console.error("DELETE /api/routes/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that route." });
    }
});

module.exports = router;