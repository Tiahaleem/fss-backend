const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// TRIPS API
// =========================
// Mirrors admin-trips.js client-side. Trips are linked to routes by
// route_id (a real foreign key) — but the frontend still wants to see
// from/to directly on each trip (that's how book_a_trip.js filters
// them), so every query here JOINs against routes to include that.

const express = require("express");
const router = express.Router();
const pool = require("../db");

function toClientShape(row) {
    return {
        id: row.id,
        routeId: row.route_id,
        from: row.from_city,
        to: row.to_city,
        time: row.departure_time.slice(0, 5), // "06:00:00" -> "06:00"
        vehicle: row.vehicle,
        seats: row.total_seats,
        status: row.status
    };
}

const SELECT_WITH_ROUTE = `
    SELECT trips.*, routes.from_city, routes.to_city
    FROM trips
    JOIN routes ON routes.id = trips.route_id
`;

// GET /api/trips — list every trip (optionally ?from=Lagos&to=Abuja&status=active)
router.get("/", async (req, res) => {
    try {
        const { from, to, status } = req.query;

        let query = SELECT_WITH_ROUTE + " WHERE 1=1";
        const params = [];

        if (from) {
            params.push(from);
            query += ` AND routes.from_city ILIKE $${params.length}`;
        }
        if (to) {
            params.push(to);
            query += ` AND routes.to_city ILIKE $${params.length}`;
        }
        if (status) {
            params.push(status);
            query += ` AND trips.status = $${params.length}`;
        }
        query += " ORDER BY routes.from_city, routes.to_city, trips.departure_time";

        const result = await pool.query(query, params);
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/trips failed:", err);
        res.status(500).json({ error: "Couldn't load trips." });
    }
});

// GET /api/trips/:id
router.get("/:id", async (req, res) => {
    try {
        const result = await pool.query(SELECT_WITH_ROUTE + " WHERE trips.id = $1", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Trip not found." });
        }

        res.json(toClientShape(result.rows[0]));
    } catch (err) {
        console.error("GET /api/trips/:id failed:", err);
        res.status(500).json({ error: "Couldn't load that trip." });
    }
});

// POST /api/trips — create a new trip on an existing route
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { routeId, time, vehicle, seats, status } = req.body;

        if (!routeId || !time || !vehicle || !seats) {
            return res.status(400).json({ error: "routeId, time, vehicle, and seats are all required." });
        }

        const insertResult = await pool.query(
            `INSERT INTO trips (route_id, departure_time, vehicle, total_seats, status)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [routeId, time, vehicle, seats, status || "active"]
        );

        const full = await pool.query(SELECT_WITH_ROUTE + " WHERE trips.id = $1", [insertResult.rows[0].id]);
        res.status(201).json(toClientShape(full.rows[0]));
    } catch (err) {
        if (err.code === "23503") {
            // Foreign key violation — routeId doesn't exist
            return res.status(400).json({ error: "That route doesn't exist." });
        }
        console.error("POST /api/trips failed:", err);
        res.status(500).json({ error: "Couldn't create that trip." });
    }
});

// PUT /api/trips/:id — update an existing trip
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { routeId, time, vehicle, seats, status } = req.body;

        const updateResult = await pool.query(
            `UPDATE trips
             SET route_id = $1, departure_time = $2, vehicle = $3,
                 total_seats = $4, status = $5, updated_at = now()
             WHERE id = $6
             RETURNING id`,
            [routeId, time, vehicle, seats, status, req.params.id]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: "Trip not found." });
        }

        const full = await pool.query(SELECT_WITH_ROUTE + " WHERE trips.id = $1", [req.params.id]);
        res.json(toClientShape(full.rows[0]));
    } catch (err) {
        if (err.code === "23503") {
            return res.status(400).json({ error: "That route doesn't exist." });
        }
        console.error("PUT /api/trips/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that trip." });
    }
});

// DELETE /api/trips/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM trips WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Trip not found." });
        }

        res.status(204).send();
    } catch (err) {
        console.error("DELETE /api/trips/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that trip." });
    }
});

module.exports = router;