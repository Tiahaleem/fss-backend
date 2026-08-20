const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// TERMINALS API
// =========================
// Mirrors admin-pickup.js client-side: GET all, GET one, POST, PUT, DELETE.

const express = require("express");
const router = express.Router();
const pool = require("../db");

function toClientShape(row) {
    return {
        id: row.id,
        city: row.city,
        name: row.name,
        address: row.address,
        phone: row.phone,
        hours: row.hours,
        status: row.status
    };
}

// GET /api/terminals — list every terminal (optionally ?status=active or ?city=Lagos)
router.get("/", async (req, res) => {
    try {
        const { status, city } = req.query;

        let query = "SELECT * FROM terminals WHERE 1=1";
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        if (city) {
            params.push(city.trim());
            query += ` AND city ILIKE $${params.length}`;
        }
        query += " ORDER BY city, name";

        const result = await pool.query(query, params);
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/terminals failed:", err);
        res.status(500).json({ error: "Couldn't load terminals." });
    }
});

// GET /api/terminals/:id
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM terminals WHERE id = $1", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Terminal not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("GET /api/terminals/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that terminal." });
    }
});

// POST /api/terminals — create a new terminal
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { city, name, address, phone, hours, status } = req.body;

        if (!city || !name || !address || !phone || !hours) {
            return res.status(400).json({ error: "city, name, address, phone, and hours are all required." });
        }

        const result = await pool.query(
            `INSERT INTO terminals (city, name, address, phone, hours, status)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING *`,
            [city, name, address, phone, hours, status || "active"]
        );

        res.status(201).json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("POST /api/terminals failed:", err);
        res.status(500).json({ error: "Couldn't create that terminal." });
    }
});

// PUT /api/terminals/:id — update an existing terminal
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { city, name, address, phone, hours, status } = req.body;

        const result = await pool.query(
            `UPDATE terminals
             SET city = $1, name = $2, address = $3, phone = $4,
                 hours = $5, status = $6, updated_at = now()
             WHERE id = $7
             RETURNING *`,
            [city, name, address, phone, hours, status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Terminal not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("PUT /api/terminals/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that terminal." });
    }
});

// DELETE /api/terminals/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM terminals WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Terminal not found." });
        }

        res.status(204).send();
    } catch (err) {
        console.error("DELETE /api/terminals/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that terminal." });
    }
});

module.exports = router;