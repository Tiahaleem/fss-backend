const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// DRIVERS API
// =========================
// A real, specific driver assignable to a trip — closes the gap
// between what the homepage promises ("background-checked drivers")
// and what the system actually tracks.

const express = require("express");
const router = express.Router();
const pool = require("../db");

function toClientShape(row) {
    return {
        id: row.id,
        name: row.name,
        licenseNumber: row.license_number,
        phone: row.phone,
        status: row.status
    };
}

// GET /api/drivers — list every driver (optionally ?status=active)
router.get("/", async (req, res) => {
    try {
        const { status } = req.query;

        let query = "SELECT * FROM drivers WHERE 1=1";
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        query += " ORDER BY name";

        const result = await pool.query(query, params);
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/drivers failed:", err);
        res.status(500).json({ error: "Couldn't load drivers." });
    }
});

// GET /api/drivers/:id
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM drivers WHERE id = $1", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Driver not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("GET /api/drivers/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that driver." });
    }
});

// POST /api/drivers — add a new driver
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { name, licenseNumber, phone, status } = req.body;

        if (!name || !phone) {
            return res.status(400).json({ error: "name and phone are required." });
        }

        const result = await pool.query(
            `INSERT INTO drivers (name, license_number, phone, status)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name, licenseNumber || null, phone, status || "active"]
        );

        res.status(201).json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("POST /api/drivers failed:", err);
        res.status(500).json({ error: "Couldn't add that driver." });
    }
});

// PUT /api/drivers/:id — update an existing driver
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { name, licenseNumber, phone, status } = req.body;

        const result = await pool.query(
            `UPDATE drivers
             SET name = $1, license_number = $2, phone = $3, status = $4
             WHERE id = $5
             RETURNING *`,
            [name, licenseNumber || null, phone, status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Driver not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("PUT /api/drivers/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that driver." });
    }
});

// DELETE /api/drivers/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM drivers WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Driver not found." });
        }

        res.status(204).send();
    } catch (err) {
        if (err.code === "23503") {
            // Foreign key violation — real trips still point at this
            // driver. Set it to Inactive instead of deleting it.
            return res.status(409).json({
                error: "This driver is assigned to real trips and can't be deleted. Set their status to Inactive instead."
            });
        }
        console.error("DELETE /api/drivers/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that driver." });
    }
});

module.exports = router;
