const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// VEHICLES API
// =========================
// A real, specific vehicle the business owns (e.g. "Honda Odyssey,
// plate ABC-123-XY") — this is what trips.js checks against to catch
// a genuine double-booking before it happens.

const express = require("express");
const router = express.Router();
const pool = require("../db");

function toClientShape(row) {
    return {
        id: row.id,
        name: row.name,
        plateNumber: row.plate_number,
        seats: row.seats,
        status: row.status
    };
}

// GET /api/vehicles — list every vehicle (optionally ?status=active)
router.get("/", async (req, res) => {
    try {
        const { status } = req.query;

        let query = "SELECT * FROM vehicles WHERE 1=1";
        const params = [];

        if (status) {
            params.push(status);
            query += ` AND status = $${params.length}`;
        }
        query += " ORDER BY name";

        const result = await pool.query(query, params);
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/vehicles failed:", err);
        res.status(500).json({ error: "Couldn't load vehicles." });
    }
});

// GET /api/vehicles/:id
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query("SELECT * FROM vehicles WHERE id = $1", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("GET /api/vehicles/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that vehicle." });
    }
});

// POST /api/vehicles — add a new vehicle
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { name, plateNumber, seats, status } = req.body;

        if (!name || !seats) {
            return res.status(400).json({ error: "name and seats are required." });
        }

        const result = await pool.query(
            `INSERT INTO vehicles (name, plate_number, seats, status)
             VALUES ($1, $2, $3, $4)
             RETURNING *`,
            [name, plateNumber || null, seats, status || "active"]
        );

        res.status(201).json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("POST /api/vehicles failed:", err);
        res.status(500).json({ error: "Couldn't add that vehicle." });
    }
});

// PUT /api/vehicles/:id — update an existing vehicle
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { name, plateNumber, seats, status } = req.body;

        const result = await pool.query(
            `UPDATE vehicles
             SET name = $1, plate_number = $2, seats = $3, status = $4
             WHERE id = $5
             RETURNING *`,
            [name, plateNumber || null, seats, status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("PUT /api/vehicles/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that vehicle." });
    }
});

// DELETE /api/vehicles/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM vehicles WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found." });
        }

        res.status(204).send();
    } catch (err) {
        if (err.code === "23503") {
            // Foreign key violation — real trips still point at this
            // vehicle. Set it to Inactive instead of deleting it.
            return res.status(409).json({
                error: "This vehicle is assigned to real trips and can't be deleted. Set its status to Inactive instead."
            });
        }
        console.error("DELETE /api/vehicles/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that vehicle." });
    }
});

module.exports = router;
