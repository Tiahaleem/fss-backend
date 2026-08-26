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
const { paystackRequest } = require("../paystack");
const { sendCancellationEmail, sendRefundEmail } = require("../email");

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
                b.reference, b.type, b.price_kobo, b.created_at, b.status,
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
                b.reference, b.type, b.price_kobo, b.created_at, b.status,
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

// =========================
// POST /api/bookings/:reference/cancel
// =========================
// Works for either the customer who owns this booking, or an admin
// (e.g. handling a phone request to cancel). Releases the seats back
// to available (passenger bookings only) and marks the booking
// cancelled — but does NOT touch the money. Refunding is a separate,
// deliberate action below, since not every cancellation should
// automatically trigger a real refund.
router.post("/:reference/cancel", requireAuth, async (req, res) => {
    const client = await pool.connect();

    try {
        const bookingResult = await client.query(
            "SELECT * FROM bookings WHERE reference = $1",
            [req.params.reference.toUpperCase()]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: "Booking not found." });
        }

        const booking = bookingResult.rows[0];

        const isOwner = booking.owner_id && booking.owner_id === req.user.id;
        const isAdmin = req.user.role === "admin";

        if (!isOwner && !isAdmin) {
            return res.status(403).json({ error: "You can only cancel your own bookings." });
        }

        if (booking.status !== "confirmed") {
            return res.status(400).json({ error: `This booking is already ${booking.status}.` });
        }

        await client.query("BEGIN");

        // For a passenger booking, actually free the seats back up —
        // deleting the seat_holds rows makes them immediately
        // available for someone else to select.
        if (booking.type === "passenger") {
            await client.query("DELETE FROM seat_holds WHERE booking_id = $1", [booking.id]);
        }

        await client.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [booking.id]);

        // The tracking timeline needs to actually reflect this —
        // otherwise it just keeps showing whatever step it was on
        // ("Awaiting boarding") forever, as if nothing happened.
        // Anything still "active" or "pending" gets closed out, and
        // a real "Booking cancelled" step gets added at the end.
        await client.query(
            "UPDATE tracking_events SET status = 'completed' WHERE booking_id = $1 AND status IN ('active', 'pending')",
            [booking.id]
        );

        const nextOrderResult = await client.query(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_order FROM tracking_events WHERE booking_id = $1",
            [booking.id]
        );

        await client.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES ($1, $2, 'Booking cancelled', to_char(now(), 'HH24:MI'), 'cancelled', 'cancelled')`,
            [booking.id, nextOrderResult.rows[0].next_order]
        );

        await client.query("COMMIT");

        // Send the notification AFTER commit — a failed email should
        // never undo a cancellation that already genuinely happened.
        try {
            let contactEmail, contactName, description;

            if (booking.type === "passenger") {
                const details = await pool.query(
                    `SELECT pb.passenger_name, pb.passenger_email, r.from_city, r.to_city
                     FROM passenger_bookings pb
                     JOIN trips t ON t.id = pb.trip_id
                     JOIN routes r ON r.id = t.route_id
                     WHERE pb.booking_id = $1`,
                    [booking.id]
                );
                contactEmail = details.rows[0].passenger_email;
                contactName = details.rows[0].passenger_name;
                description = `${details.rows[0].from_city} → ${details.rows[0].to_city} trip`;
            } else {
                const details = await pool.query(
                    "SELECT sender_name, sender_email, from_city, to_city FROM parcel_bookings WHERE booking_id = $1",
                    [booking.id]
                );
                contactEmail = details.rows[0].sender_email;
                contactName = details.rows[0].sender_name;
                description = `${details.rows[0].from_city} → ${details.rows[0].to_city} parcel`;
            }

            await sendCancellationEmail(contactEmail, { name: contactName, reference: booking.reference, description });
        } catch (emailErr) {
            console.error("Cancellation email failed:", emailErr.message);
        }

        res.json({ reference: booking.reference, status: "cancelled" });
    } catch (err) {
        await client.query("ROLLBACK");
        console.error("POST /api/bookings/:reference/cancel failed:", err.message);
        res.status(500).json({ error: "Couldn't cancel that booking." });
    } finally {
        client.release();
    }
});

// =========================
// POST /api/bookings/:reference/refund — ADMIN ONLY
// =========================
// Issues a REAL refund through Paystack, against the actual payment
// that was made. Needs payment_reference to exist — a booking with
// no stored payment reference (e.g. very old test data) can't be
// refunded through Paystack and would need handling outside the system.
router.post("/:reference/refund", requireAdmin, async (req, res) => {
    try {
        const bookingResult = await pool.query(
            "SELECT * FROM bookings WHERE reference = $1",
            [req.params.reference.toUpperCase()]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: "Booking not found." });
        }

        const booking = bookingResult.rows[0];

        if (booking.status === "refunded") {
            return res.status(400).json({ error: "This booking has already been refunded." });
        }

        if (!booking.payment_reference) {
            return res.status(400).json({ error: "No payment reference on file for this booking — it can't be refunded through Paystack automatically." });
        }

        // The actual real refund call — Paystack reverses the charge
        // on the customer's card/account.
        await paystackRequest("/refund", {
            method: "POST",
            body: JSON.stringify({ transaction: booking.payment_reference })
        });

        await pool.query("UPDATE bookings SET status = 'refunded' WHERE id = $1", [booking.id]);

        try {
            let contactEmail, contactName;

            if (booking.type === "passenger") {
                const details = await pool.query("SELECT passenger_name, passenger_email FROM passenger_bookings WHERE booking_id = $1", [booking.id]);
                contactEmail = details.rows[0].passenger_email;
                contactName = details.rows[0].passenger_name;
            } else {
                const details = await pool.query("SELECT sender_name, sender_email FROM parcel_bookings WHERE booking_id = $1", [booking.id]);
                contactEmail = details.rows[0].sender_email;
                contactName = details.rows[0].sender_name;
            }

            await sendRefundEmail(contactEmail, {
                name: contactName,
                reference: booking.reference,
                amount: `₦${(Number(booking.price_kobo) / 100).toLocaleString()}`
            });
        } catch (emailErr) {
            console.error("Refund email failed:", emailErr.message);
        }

        res.json({ reference: booking.reference, status: "refunded" });
    } catch (err) {
        console.error("POST /api/bookings/:reference/refund failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't process that refund." });
    }
});

module.exports = router;
