// =========================
// SEAT HOLDS API — date-aware
// =========================
// Every seat is now tracked per (trip, travel date, seat number) —
// the UNIQUE constraint in the database covers all three. Booking
// seat 3 on the 6am Lagos→Abuja trip for today has zero effect on
// seat 3 for that same trip next Tuesday; they're genuinely
// independent seat maps now, not just visually separate.
//
// travel_date is accepted as ?date=YYYY-MM-DD on GET, or
// { travelDate } in the body on POST/DELETE — defaults to today if
// not provided, matching the original (pre-date-aware) behavior for
// any old links still floating around without a date.

const express = require("express");
const router = express.Router({ mergeParams: true }); // mergeParams so :tripId from the parent route is available
const pool = require("../db");

const HOLD_MINUTES = 10;

function todayDate() {
    return new Date().toISOString().split("T")[0];
}

// Deletes any hold for this seat+date that's already expired, so an
// abandoned hold genuinely frees up instead of blocking forever.
async function clearExpiredHold(client, tripId, travelDate, seatNumber) {
    await client.query(
        `DELETE FROM seat_holds
         WHERE trip_id = $1 AND travel_date = $2 AND seat_number = $3
           AND status = 'held' AND expires_at < now()`,
        [tripId, travelDate, seatNumber]
    );
}

// GET /api/trips/:tripId/seats?date=YYYY-MM-DD — current state of every held/booked seat on this trip, for this date
router.get("/", async (req, res) => {
    try {
        const travelDate = req.query.date || todayDate();

        const result = await pool.query(
            `SELECT seat_number, status, held_by_session, expires_at
             FROM seat_holds
             WHERE trip_id = $1 AND travel_date = $2
               AND (status = 'booked' OR (status = 'held' AND expires_at > now()))`,
            [req.params.tripId, travelDate]
        );

        res.json(result.rows.map(r => ({
            seatNumber: r.seat_number,
            status: r.status,
            heldBy: r.held_by_session,
            expiresAt: r.expires_at
        })));
    } catch (err) {
        console.error("GET /api/trips/:tripId/seats failed:", err);
        res.status(500).json({ error: "Couldn't load seat availability." });
    }
});

// POST /api/trips/:tripId/seats/:seatNumber/hold — place a 10-minute hold for a specific date
router.post("/:seatNumber/hold", async (req, res) => {
    const client = await pool.connect();

    try {
        const { tripId, seatNumber } = req.params;
        const { sessionId, travelDate } = req.body;
        const dateToUse = travelDate || todayDate();

        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required." });
        }

        await clearExpiredHold(client, tripId, dateToUse, seatNumber);

        const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

        const result = await client.query(
            `INSERT INTO seat_holds (trip_id, travel_date, seat_number, status, held_by_session, expires_at)
             VALUES ($1, $2, $3, 'held', $4, $5)
             RETURNING *`,
            [tripId, dateToUse, seatNumber, sessionId, expiresAt]
        );

        res.status(201).json({
            seatNumber: result.rows[0].seat_number,
            status: result.rows[0].status,
            expiresAt: result.rows[0].expires_at
        });
    } catch (err) {
        if (err.code === "23505") {
            // The UNIQUE constraint did its job — someone already has this seat, on this date
            return res.status(409).json({ error: "That seat was just taken. Please pick another." });
        }
        console.error("POST .../hold failed:", err);
        res.status(500).json({ error: "Couldn't hold that seat." });
    } finally {
        client.release();
    }
});

// DELETE /api/trips/:tripId/seats/:seatNumber/hold — release your own hold
// (e.g. the customer picked a different seat instead)
router.delete("/:seatNumber/hold", async (req, res) => {
    try {
        const { tripId, seatNumber } = req.params;
        const { sessionId, travelDate } = req.body;
        const dateToUse = travelDate || todayDate();

        await pool.query(
            `DELETE FROM seat_holds
             WHERE trip_id = $1 AND travel_date = $2 AND seat_number = $3
               AND status = 'held' AND held_by_session = $4`,
            [tripId, dateToUse, seatNumber, sessionId]
        );

        res.status(204).send();
    } catch (err) {
        console.error("DELETE .../hold failed:", err);
        res.status(500).json({ error: "Couldn't release that seat." });
    }
});

module.exports = router;
