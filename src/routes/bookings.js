// =========================
// BOOKINGS API
// =========================
// The piece that ties everything together: creating a booking
// touches bookings + (passenger_bookings or parcel_bookings) +
// seat_holds + tracking_events, all as ONE transaction — either
// every table gets updated correctly, or none of them do. That's
// something localStorage could never guarantee.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth, requireAdmin, optionalAuth } = require("../middleware/requireAuth");

function generateReference(prefix) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = prefix + "-";
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// =========================
// POST /api/bookings/passenger
// =========================
router.post("/passenger", optionalAuth, async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            tripId, terminalId, seatNumbers, sessionId,
            passengerName, passengerEmail, passengerPhone, travelDate
        } = req.body;

        if (!tripId || !terminalId || !Array.isArray(seatNumbers) || seatNumbers.length === 0 ||
            !passengerName || !passengerEmail || !passengerPhone || !travelDate) {
            return res.status(400).json({ error: "Missing required booking details — seatNumbers must be a non-empty array." });
        }

        await client.query("BEGIN");

        // Look up the trip + its route's price, to know what to charge
        const tripResult = await client.query(
            `SELECT trips.id, routes.price_kobo
             FROM trips JOIN routes ON routes.id = trips.route_id
             WHERE trips.id = $1`,
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ error: "That trip doesn't exist." });
        }

        // Price is per seat — the total charged is per-seat price × how many seats
        const pricePerSeatKobo = tripResult.rows[0].price_kobo;
        const totalPriceKobo = pricePerSeatKobo * seatNumbers.length;
        const reference = generateReference("FSS");

        // Create the shared booking row (covers the whole group, however many seats)
        const bookingResult = await client.query(
            `INSERT INTO bookings (reference, type, owner_id, price_kobo)
             VALUES ($1, 'passenger', $2, $3)
             RETURNING id, created_at`,
            [reference, req.user ? req.user.id : null, totalPriceKobo]
        );
        const bookingId = bookingResult.rows[0].id;

        // Create the passenger-specific details — one row for the
        // whole group, not one per seat
        await client.query(
            `INSERT INTO passenger_bookings
                (booking_id, trip_id, terminal_id, passenger_name, passenger_email, passenger_phone, travel_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [bookingId, tripId, terminalId, passengerName, passengerEmail, passengerPhone, travelDate]
        );

        // Finalize EVERY seat in the group as booked, in the same
        // transaction — either all of them go through, or none do.
        // If any single seat was grabbed by someone else in the
        // meantime, the whole booking rolls back rather than leaving
        // a group with some seats confirmed and others missing.
        for (const seatNumber of seatNumbers) {
            await client.query(
                `INSERT INTO seat_holds (trip_id, seat_number, status, booking_id, expires_at)
                 VALUES ($1, $2, 'booked', $3, NULL)
                 ON CONFLICT (trip_id, seat_number)
                 DO UPDATE SET status = 'booked', booking_id = $3, held_by_session = NULL, expires_at = NULL
                 WHERE seat_holds.status = 'held' AND seat_holds.held_by_session = $4`,
                [tripId, seatNumber, bookingId, sessionId || null]
            );

            const seatCheck = await client.query(
                `SELECT booking_id FROM seat_holds WHERE trip_id = $1 AND seat_number = $2`,
                [tripId, seatNumber]
            );

            if (!seatCheck.rows[0] || seatCheck.rows[0].booking_id !== bookingId) {
                await client.query("ROLLBACK");
                return res.status(409).json({ error: `Seat ${seatNumber} was just taken by someone else. Please pick again.` });
            }
        }

        // Starter tracking events, same two steps as before
        await client.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES
                ($1, 1, 'Booking confirmed', to_char(now(), 'HH24:MI'), 'completed', 'boarding'),
                ($1, 2, 'Awaiting boarding', to_char(now(), 'HH24:MI'), 'active', 'location')`,
            [bookingId]
        );

        await client.query("COMMIT");

        res.status(201).json({ reference, bookingId, priceKobo: totalPriceKobo, seatCount: seatNumbers.length });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("POST /api/bookings/passenger failed:", err);
        res.status(500).json({ error: "Couldn't create that booking." });
    } finally {
        client.release();
    }
});

// =========================
// POST /api/bookings/parcel
// =========================
router.post("/parcel", optionalAuth, async (req, res) => {
    const client = await pool.connect();

    try {
        const {
            fromCity, toCity, senderName, senderPhone,
            receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo
        } = req.body;

        if (!fromCity || !toCity || !senderName || !senderPhone || !receiverName || !receiverPhone || !description || !weightKg) {
            return res.status(400).json({ error: "Missing required parcel details." });
        }

        await client.query("BEGIN");

        const reference = generateReference("PCL");

        const bookingResult = await client.query(
            `INSERT INTO bookings (reference, type, owner_id, price_kobo)
             VALUES ($1, 'parcel', $2, $3)
             RETURNING id`,
            [reference, req.user ? req.user.id : null, priceKobo || 0]
        );
        const bookingId = bookingResult.rows[0].id;

        await client.query(
            `INSERT INTO parcel_bookings
                (booking_id, from_city, to_city, sender_name, sender_phone, receiver_name, receiver_phone, description, weight_kg, declared_value_kobo)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [bookingId, fromCity, toCity, senderName, senderPhone, receiverName, receiverPhone, description, weightKg, declaredValueKobo || 0]
        );

        await client.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES ($1, 1, 'Pickup scheduled', to_char(now(), 'HH24:MI'), 'active', 'boarding')`,
            [bookingId]
        );

        await client.query("COMMIT");

        res.status(201).json({ reference, bookingId });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("POST /api/bookings/parcel failed:", err);
        res.status(500).json({ error: "Couldn't create that booking." });
    } finally {
        client.release();
    }
});

// =========================
// GET /api/bookings/track/:reference — public, used by track.html
// =========================
router.get("/track/:reference", async (req, res) => {
    try {
        const bookingResult = await pool.query(
            "SELECT id, reference, type FROM bookings WHERE reference = $1",
            [req.params.reference.toUpperCase()]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: "No booking found for that reference." });
        }

        const booking = bookingResult.rows[0];

        const eventsResult = await pool.query(
            `SELECT title, event_time, status, icon
             FROM tracking_events
             WHERE booking_id = $1
             ORDER BY sort_order`,
            [booking.id]
        );

        res.json({
            reference: booking.reference,
            type: booking.type,
            events: eventsResult.rows
        });
    } catch (err) {
        console.error("GET /api/bookings/track/:reference failed:", err);
        res.status(500).json({ error: "Couldn't look up that reference." });
    }
});

// =========================
// GET /api/bookings/mine — requires login, used by my-bookings.html
// =========================
router.get("/mine", requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                b.reference, b.type, b.price_kobo, b.created_at,
                (SELECT string_agg(seat_number, ', ' ORDER BY seat_number) FROM seat_holds WHERE booking_id = b.id) AS seat_numbers,
                pb.travel_date,
                r.from_city AS trip_from, r.to_city AS trip_to,
                t.departure_time,
                term.name AS pickup_terminal_name,
                pab.from_city, pab.to_city, pab.receiver_name
             FROM bookings b
             LEFT JOIN passenger_bookings pb ON pb.booking_id = b.id
             LEFT JOIN trips t ON t.id = pb.trip_id
             LEFT JOIN routes r ON r.id = t.route_id
             LEFT JOIN terminals term ON term.id = pb.terminal_id
             LEFT JOIN parcel_bookings pab ON pab.booking_id = b.id
             WHERE b.owner_id = $1
             ORDER BY b.created_at DESC`,
            [req.user.id]
        );

        res.json(result.rows);
    } catch (err) {
        console.error("GET /api/bookings/mine failed:", err);
        res.status(500).json({ error: "Couldn't load your bookings." });
    }
});

// =========================
// GET /api/bookings — admin only, full list with details
// =========================
router.get("/", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT
                b.reference, b.type, b.price_kobo, b.created_at,
                pb.passenger_name, pb.passenger_phone,
                (SELECT string_agg(seat_number, ', ' ORDER BY seat_number) FROM seat_holds WHERE booking_id = b.id) AS seat_numbers,
                pab.sender_name, pab.sender_phone, pab.receiver_name, pab.receiver_phone,
                pab.from_city, pab.to_city
             FROM bookings b
             LEFT JOIN passenger_bookings pb ON pb.booking_id = b.id
             LEFT JOIN parcel_bookings pab ON pab.booking_id = b.id
             ORDER BY b.created_at DESC`
        );

        res.json(result.rows);
    } catch (err) {
        console.error("GET /api/bookings failed:", err);
        res.status(500).json({ error: "Couldn't load bookings." });
    }
});

module.exports = router;