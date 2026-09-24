// =========================
// WAITLIST API
// =========================
// A customer on a fully-booked trip can leave their details here.
// The actual notification fires from bookings.js, right after a real
// cancellation frees up seats — this file owns "join" and the shared
// "who should actually be told about this" logic.
//
// Nobody gets told about an opening that's too small for what they
// actually asked for — someone wanting 3 seats together shouldn't
// get excited about a single seat opening up.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { sendWaitlistNotificationEmail } = require("../email");

// POST /api/waitlist — join the waitlist for a specific trip+date
router.post("/", async (req, res) => {
    try {
        const { tripId, travelDate, name, email, phone, seatsWanted } = req.body;

        if (!tripId || !travelDate || !name || !email || !phone || !seatsWanted) {
            return res.status(400).json({ error: "tripId, travelDate, name, email, phone, and seatsWanted are all required." });
        }

        const tripCheck = await pool.query("SELECT id FROM trips WHERE id = $1", [tripId]);
        if (tripCheck.rows.length === 0) {
            return res.status(404).json({ error: "That trip doesn't exist." });
        }

        await pool.query(
            `INSERT INTO waitlist_entries (trip_id, travel_date, name, email, phone, seats_wanted)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tripId, travelDate, name, email, phone, seatsWanted]
        );

        res.status(201).json({ joined: true });
    } catch (err) {
        console.error("POST /api/waitlist failed:", err);
        res.status(500).json({ error: "Couldn't join the waitlist right now." });
    }
});

// Called from bookings.js right after a real cancellation frees up
// `seatsFreed` seats on a specific trip+date. Only notifies waiting
// entries whose seats_wanted actually fits within that many seats —
// oldest request first, since that's who's been waiting longest —
// and stops once the freed seats are accounted for, rather than
// telling everyone regardless of whether it'd actually work for them.
async function notifyWaitlist(tripId, travelDate, seatsFreed) {
    try {
        if (!seatsFreed || seatsFreed <= 0) return;

        const waitingResult = await pool.query(
            `SELECT w.id, w.name, w.email, w.seats_wanted,
                    r.from_city, r.to_city, t.departure_time
             FROM waitlist_entries w
             JOIN trips t ON t.id = w.trip_id
             JOIN routes r ON r.id = t.route_id
             WHERE w.trip_id = $1 AND w.travel_date = $2 AND w.status = 'waiting'
             ORDER BY w.created_at ASC`,
            [tripId, travelDate]
        );

        if (waitingResult.rows.length === 0) return;

        const travelDateText = new Date(travelDate).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

        let seatsRemaining = seatsFreed;

        for (const row of waitingResult.rows) {
            if (seatsRemaining <= 0) break;
            if (row.seats_wanted > seatsRemaining) continue; // doesn't fit yet — leave them waiting, a later cancellation might

            await sendWaitlistNotificationEmail(row.email, {
                name: row.name,
                route: `${row.from_city} → ${row.to_city}`,
                travelDate: travelDateText,
                travelDateRaw: travelDate,
                departureTime: row.departure_time.slice(0, 5),
                tripId
            });

            await pool.query("UPDATE waitlist_entries SET status = 'notified' WHERE id = $1", [row.id]);

            seatsRemaining -= row.seats_wanted;
        }
    } catch (err) {
        // A waitlist notification failing should never break the
        // actual cancellation it's riding along with — log it and
        // move on.
        console.error("notifyWaitlist failed:", err);
    }
}

module.exports = router;
module.exports.notifyWaitlist = notifyWaitlist;
