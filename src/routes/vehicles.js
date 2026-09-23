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
        layout: row.layout,
        hasAC: row.has_ac,
        vehicleClass: row.vehicle_class,
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
        const { name, plateNumber, seats, layout, hasAC, vehicleClass, status } = req.body;

        if (!name || !seats) {
            return res.status(400).json({ error: "name and seats are required." });
        }

        const result = await pool.query(
            `INSERT INTO vehicles (name, plate_number, seats, layout, has_ac, vehicle_class, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING *`,
            [name, plateNumber || null, seats, layout || null, hasAC !== false, vehicleClass || null, status || "active"]
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
        const { name, plateNumber, seats, layout, hasAC, vehicleClass, status } = req.body;

        // Don't let a vehicle's capacity shrink below a seat number
        // that's already a real, paid booking — that would leave a
        // paying customer's seat literally not existing anymore.
        const conflictingBooking = await pool.query(
            `SELECT sh.seat_number, r.from_city, r.to_city, t.departure_time
             FROM seat_holds sh
             JOIN trips t ON t.id = sh.trip_id
             JOIN routes r ON r.id = t.route_id
             WHERE t.vehicle_id = $1 AND sh.status = 'booked' AND sh.seat_number::int > $2
             LIMIT 1`,
            [req.params.id, seats]
        );

        if (conflictingBooking.rows.length > 0) {
            const b = conflictingBooking.rows[0];
            return res.status(409).json({
                error: `Can't reduce to ${seats} seats — seat ${b.seat_number} is already booked on the ${b.from_city} → ${b.to_city} trip at ${b.departure_time.slice(0, 5)}.`
            });
        }

        const result = await pool.query(
            `UPDATE vehicles
             SET name = $1, plate_number = $2, seats = $3, layout = $4, has_ac = $5, vehicle_class = $6, status = $7
             WHERE id = $8
             RETURNING *`,
            [name, plateNumber || null, seats, layout || null, hasAC !== false, vehicleClass || null, status, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Vehicle not found." });
        }

        // A trip's seat count is a snapshot taken when it was
        // created — without this, correcting a vehicle's real seat
        // count here would leave every EXISTING trip using it stuck
        // showing the old, wrong number forever.
        await pool.query(
            "UPDATE trips SET total_seats = $1 WHERE vehicle_id = $2",
            [seats, req.params.id]
        );

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
