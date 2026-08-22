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
const { requireAuth, requireAdmin } = require("../middleware/requireAuth");
const { createPassengerBooking, createParcelBooking } = require("../bookingCreators");

// =========================
// POST /api/bookings/passenger — ADMIN ONLY now
// =========================
// Real customers no longer hit this directly — they go through
// /api/payments/initialize-passenger, which only creates the actual
// booking after Paystack confirms the payment genuinely succeeded.
// This stays open for admin use (manual/support bookings, e.g. a
// phone booking that needs entering by hand).
router.post("/passenger", requireAdmin, async (req, res) => {
    try {
        const result = await createPassengerBooking(req.body);
        res.status(201).json(result);
    } catch (err) {
        console.error("POST /api/bookings/passenger failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't create that booking." });
    }
});

// =========================
// POST /api/bookings/parcel — ADMIN ONLY now
// =========================
router.post("/parcel", requireAdmin, async (req, res) => {
    try {
        const result = await createParcelBooking(req.body);
        res.status(201).json(result);
    } catch (err) {
        console.error("POST /api/bookings/parcel failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't create that booking." });
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