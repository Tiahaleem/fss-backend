// =========================
// SEAT HOLDS API
// =========================
// This replaces the localStorage-based holds from select_a_seat.js —
// but this time, the protection is REAL. Two different customers on
// two different phones both trying to grab seat 3 on the same trip
// will genuinely conflict here, because seat_holds has a UNIQUE
// constraint on (trip_id, seat_number) — the database itself refuses
// the second one, not application code trying to catch a race
// condition after the fact.

const express = require("express");
const router = express.Router({ mergeParams: true }); // mergeParams so :tripId from the parent route is available
const pool = require("../db");

const HOLD_MINUTES = 10;

// Deletes any hold for this seat that's already expired, so an
// abandoned hold genuinely frees up instead of blocking forever.
async function clearExpiredHold(client, tripId, seatNumber) {
    await client.query(
        `DELETE FROM seat_holds
         WHERE trip_id = $1 AND seat_number = $2
           AND status = 'held' AND expires_at < now()`,
        [tripId, seatNumber]
    );
}

// GET /api/trips/:tripId/seats — current state of every held/booked seat on this trip
router.get("/", async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT seat_number, status, held_by_session, expires_at
             FROM seat_holds
             WHERE trip_id = $1
               AND (status = 'booked' OR (status = 'held' AND expires_at > now()))`,
            [req.params.tripId]
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

// POST /api/trips/:tripId/seats/:seatNumber/hold — place a 10-minute hold
router.post("/:seatNumber/hold", async (req, res) => {
    const client = await pool.connect();

    try {
        const { tripId, seatNumber } = req.params;
        const { sessionId } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: "sessionId is required." });
        }

        await clearExpiredHold(client, tripId, seatNumber);

        const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

        const result = await client.query(
            `INSERT INTO seat_holds (trip_id, seat_number, status, held_by_session, expires_at)
             VALUES ($1, $2, 'held', $3, $4)
             RETURNING *`,
            [tripId, seatNumber, sessionId, expiresAt]
        );

        res.status(201).json({
            seatNumber: result.rows[0].seat_number,
            status: result.rows[0].status,
            expiresAt: result.rows[0].expires_at
        });
    } catch (err) {
        if (err.code === "23505") {
            // The UNIQUE constraint did its job — someone already has this seat
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
        const { sessionId } = req.body;

        await pool.query(
            `DELETE FROM seat_holds
             WHERE trip_id = $1 AND seat_number = $2
               AND status = 'held' AND held_by_session = $3`,
            [tripId, seatNumber, sessionId]
        );

        res.status(204).send();
    } catch (err) {
        console.error("DELETE .../hold failed:", err);
        res.status(500).json({ error: "Couldn't release that seat." });
    }
});

module.exports = router;