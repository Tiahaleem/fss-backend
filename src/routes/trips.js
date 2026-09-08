const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// TRIPS API
// =========================
// A trip is now linked to a REAL vehicle (vehicle_id), not just a
// text label — total_seats is always taken directly from that
// vehicle's actual capacity, so it can never drift out of sync.
//
// Before creating or updating a trip, this checks whether the chosen
// vehicle is already committed to another active trip at an
// overlapping time — since trips repeat daily at the same time, a
// genuine conflict here would mean a real double-booking every
// single day, not just a one-off.
//
// Known simplification: overlap math assumes a trip doesn't run past
// midnight into the next day. A route genuinely long/late enough to
// cross midnight would need a more careful check than this.

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
        vehicleId: row.vehicle_id,
        vehicleName: row.vehicle_name,
        vehiclePlate: row.vehicle_plate,
        seats: row.total_seats,
        status: row.status
    };
}

const SELECT_WITH_ROUTE = `
    SELECT trips.*, routes.from_city, routes.to_city, routes.duration,
           vehicles.name AS vehicle_name, vehicles.plate_number AS vehicle_plate
    FROM trips
    JOIN routes ON routes.id = trips.route_id
    LEFT JOIN vehicles ON vehicles.id = trips.vehicle_id
`;

// "11h 30m" -> 690. Handles "11h", "30m", or "11h 30m" — whatever's present.
function parseDurationToMinutes(duration) {
    const hoursMatch = String(duration).match(/(\d+)\s*h/);
    const minsMatch = String(duration).match(/(\d+)\s*m/);
    const hours = hoursMatch ? Number(hoursMatch[1]) : 0;
    const mins = minsMatch ? Number(minsMatch[1]) : 0;
    return hours * 60 + mins;
}

function timeToMinutes(time) {
    const [h, m] = String(time).split(":").map(Number);
    return h * 60 + m;
}

// Checks every other ACTIVE trip already using this vehicle for a
// time overlap. Returns the conflicting trip's info if found, else null.
async function findVehicleConflict(vehicleId, departureTime, routeId, excludeTripId) {
    if (!vehicleId) return null;

    const routeResult = await pool.query("SELECT duration FROM routes WHERE id = $1", [routeId]);
    if (routeResult.rows.length === 0) return null;

    const newStart = timeToMinutes(departureTime);
    const newEnd = newStart + parseDurationToMinutes(routeResult.rows[0].duration);

    const existingTrips = await pool.query(
        `SELECT trips.id, trips.departure_time, routes.duration, routes.from_city, routes.to_city
         FROM trips
         JOIN routes ON routes.id = trips.route_id
         WHERE trips.vehicle_id = $1 AND trips.status = 'active' AND trips.id != $2`,
        [vehicleId, excludeTripId || "00000000-0000-0000-0000-000000000000"]
    );

    for (const trip of existingTrips.rows) {
        const existingStart = timeToMinutes(trip.departure_time);
        const existingEnd = existingStart + parseDurationToMinutes(trip.duration);

        // Real overlap check: two time ranges overlap if one starts
        // before the other ends, in both directions.
        if (newStart < existingEnd && existingStart < newEnd) {
            return {
                route: `${trip.from_city} → ${trip.to_city}`,
                time: String(trip.departure_time).slice(0, 5)
            };
        }
    }

    return null;
}

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
        const { routeId, time, vehicleId, status } = req.body;

        if (!routeId || !time || !vehicleId) {
            return res.status(400).json({ error: "routeId, time, and vehicleId are all required." });
        }

        const vehicleResult = await pool.query("SELECT seats FROM vehicles WHERE id = $1", [vehicleId]);
        if (vehicleResult.rows.length === 0) {
            return res.status(400).json({ error: "That vehicle doesn't exist." });
        }

        const conflict = await findVehicleConflict(vehicleId, time, routeId, null);
        if (conflict) {
            return res.status(409).json({
                error: `This vehicle is already scheduled for the ${conflict.route} trip at ${conflict.time}, which overlaps with this time. Please choose a different vehicle or time.`
            });
        }

        const insertResult = await pool.query(
            `INSERT INTO trips (route_id, departure_time, vehicle_id, total_seats, status)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING id`,
            [routeId, time, vehicleId, vehicleResult.rows[0].seats, status || "active"]
        );

        const full = await pool.query(SELECT_WITH_ROUTE + " WHERE trips.id = $1", [insertResult.rows[0].id]);
        res.status(201).json(toClientShape(full.rows[0]));
    } catch (err) {
        if (err.code === "23503") {
            return res.status(400).json({ error: "That route doesn't exist." });
        }
        console.error("POST /api/trips failed:", err);
        res.status(500).json({ error: "Couldn't create that trip." });
    }
});

// PUT /api/trips/:id — update an existing trip
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { routeId, time, vehicleId, status } = req.body;

        const vehicleResult = await pool.query("SELECT seats FROM vehicles WHERE id = $1", [vehicleId]);
        if (vehicleResult.rows.length === 0) {
            return res.status(400).json({ error: "That vehicle doesn't exist." });
        }

        const conflict = await findVehicleConflict(vehicleId, time, routeId, req.params.id);
        if (conflict) {
            return res.status(409).json({
                error: `This vehicle is already scheduled for the ${conflict.route} trip at ${conflict.time}, which overlaps with this time. Please choose a different vehicle or time.`
            });
        }

        const updateResult = await pool.query(
            `UPDATE trips
             SET route_id = $1, departure_time = $2, vehicle_id = $3,
                 total_seats = $4, status = $5, updated_at = now()
             WHERE id = $6
             RETURNING id`,
            [routeId, time, vehicleId, vehicleResult.rows[0].seats, status, req.params.id]
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
        if (err.code === "23503") {
            // Foreign key violation — real bookings still point at this
            // trip. Deleting it would corrupt their records, so the
            // database correctly refuses. Inactive is the right move
            // instead — it hides the trip from customers without
            // destroying anyone's real booking history.
            return res.status(409).json({
                error: "This trip has real bookings attached to it and can't be deleted. Set its status to Inactive instead — that hides it from customers without losing the booking records."
            });
        }
        console.error("DELETE /api/trips/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that trip." });
    }
});

module.exports = router;
