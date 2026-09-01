// =========================
// TRACKING EVENTS API (admin)
// =========================
// Starter events get created automatically when a booking is made
// (see bookings.js) — this is for admin adding further steps
// ("Departed terminal", "Passed checkpoint", "Arrived") as a trip or
// parcel actually progresses. Every event belongs to a REAL existing
// booking (found by its reference) — there's no way to create an
// event for a reference that doesn't exist, unlike the old
// localStorage version where you could type anything.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdmin } = require("../middleware/requireAuth");
const { sendDepartedEmail } = require("../email");
const { sendDepartedSMS } = require("../sms");

function toClientShape(row) {
    return {
        id: row.id,
        reference: row.reference,
        order: row.sort_order,
        title: row.title,
        time: row.event_time,
        status: row.status,
        icon: row.icon
    };
}

const SELECT_WITH_REFERENCE = `
    SELECT tracking_events.*, bookings.reference
    FROM tracking_events
    JOIN bookings ON bookings.id = tracking_events.booking_id
`;

// GET /api/events — every timeline event across every booking, for the admin table
router.get("/", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(SELECT_WITH_REFERENCE + " ORDER BY bookings.reference, tracking_events.sort_order");
        res.json(result.rows.map(toClientShape));
    } catch (err) {
        console.error("GET /api/events failed:", err);
        res.status(500).json({ error: "Couldn't load tracking events." });
    }
});

// POST /api/events — add an event to an EXISTING booking (found by reference)
router.post("/", requireAdmin, async (req, res) => {
    try {
        const { reference, order, title, time, status, icon } = req.body;

        if (!reference || !order || !title || !time || !status) {
            return res.status(400).json({ error: "reference, order, title, time, and status are all required." });
        }

        const bookingResult = await pool.query("SELECT id FROM bookings WHERE reference = $1", [reference.toUpperCase()]);

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: `No booking found with reference ${reference}. Events can only be added to real, existing bookings.` });
        }

        const insertResult = await pool.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id`,
            [bookingResult.rows[0].id, order, title, time, status, icon || "location"]
        );

        const full = await pool.query(SELECT_WITH_REFERENCE + " WHERE tracking_events.id = $1", [insertResult.rows[0].id]);

        // "Departed" is the one event that specifically triggers its
        // own email — this is the moment a customer actually wants
        // to know their bus is genuinely moving, not just that some
        // internal status field changed.
        if (icon === "departed") {
            const passengerResult = await pool.query(
                `SELECT pb.passenger_name, pb.passenger_email, pb.passenger_phone,
                        r.from_city, r.to_city, term.name AS terminal_name
                 FROM passenger_bookings pb
                 JOIN bookings b ON b.id = pb.booking_id
                 JOIN trips t ON t.id = pb.trip_id
                 JOIN routes r ON r.id = t.route_id
                 JOIN terminals term ON term.id = pb.terminal_id
                 WHERE b.id = $1`,
                [bookingResult.rows[0].id]
            );

            if (passengerResult.rows.length > 0) {
                const p = passengerResult.rows[0];
                const routeText = `${p.from_city} → ${p.to_city}`;

                sendDepartedEmail(p.passenger_email, {
                    passengerName: p.passenger_name,
                    reference: reference.toUpperCase(),
                    route: routeText,
                    departedTime: time
                });

                sendDepartedSMS(p.passenger_phone, {
                    reference: reference.toUpperCase(),
                    route: routeText
                });
            }
        }

        res.status(201).json(toClientShape(full.rows[0]));
    } catch (err) {
        console.error("POST /api/events failed:", err);
        res.status(500).json({ error: "Couldn't add that event." });
    }
});

// PUT /api/events/:id — update an existing event
router.put("/:id", requireAdmin, async (req, res) => {
    try {
        const { order, title, time, status, icon } = req.body;

        const updateResult = await pool.query(
            `UPDATE tracking_events
             SET sort_order = $1, title = $2, event_time = $3, status = $4, icon = $5
             WHERE id = $6
             RETURNING id`,
            [order, title, time, status, icon, req.params.id]
        );

        if (updateResult.rows.length === 0) {
            return res.status(404).json({ error: "Event not found." });
        }

        const full = await pool.query(SELECT_WITH_REFERENCE + " WHERE tracking_events.id = $1", [req.params.id]);
        res.json(toClientShape(full.rows[0]));
    } catch (err) {
        console.error("PUT /api/events/:id failed:", err);
        res.status(500).json({ error: "Couldn't update that event." });
    }
});

// DELETE /api/events/:id
router.delete("/:id", requireAdmin, async (req, res) => {
    try {
        const result = await pool.query("DELETE FROM tracking_events WHERE id = $1 RETURNING id", [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Event not found." });
        }

        res.status(204).send();
    } catch (err) {
        console.error("DELETE /api/events/:id failed:", err);
        res.status(500).json({ error: "Couldn't delete that event." });
    }
});

module.exports = router;