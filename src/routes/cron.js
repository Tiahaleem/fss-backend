// =========================
// CRON — scheduled tasks
// =========================
// This endpoint doesn't get called by your website at all — it's
// meant to be visited automatically, every few minutes, by an
// outside scheduling service (like cron-job.org), since Render's
// free tier can't reliably run its own background timer (the server
// falls asleep after 15 minutes with no visitors).
//
// Protected by a shared secret in the URL (?key=...) instead of a
// login, since there's no real "user" making this request — just an
// automated visit. Never share this key publicly.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { sendDepartureReminderEmail } = require("../email");
const { sendDepartureReminderSMS } = require("../sms");

const CRON_SECRET = process.env.CRON_SECRET;

// GET /api/cron/send-departure-reminders?key=...
router.get("/send-departure-reminders", async (req, res) => {
    if (!CRON_SECRET || req.query.key !== CRON_SECRET) {
        return res.status(401).json({ error: "Invalid or missing key." });
    }

    try {
        // Every passenger booking whose trip departs (today's date +
        // that trip's time) within the next 2 hours, and hasn't
        // already had its reminder sent.
        const result = await pool.query(
            `SELECT
                pb.booking_id, pb.passenger_name, pb.passenger_email, pb.passenger_phone,
                b.reference,
                r.from_city, r.to_city, t.departure_time,
                term.name AS terminal_name,
                (SELECT string_agg(seat_number, ', ' ORDER BY seat_number) FROM seat_holds WHERE booking_id = pb.booking_id) AS seat_numbers
             FROM passenger_bookings pb
             JOIN bookings b ON b.id = pb.booking_id
             JOIN trips t ON t.id = pb.trip_id
             JOIN routes r ON r.id = t.route_id
             JOIN terminals term ON term.id = pb.terminal_id
             WHERE pb.reminder_sent_at IS NULL
               AND pb.travel_date = CURRENT_DATE
               AND (pb.travel_date + t.departure_time)::timestamp
                   BETWEEN now() AND now() + interval '2 hours'`
        );

        let sentCount = 0;

        for (const row of result.rows) {
            const routeText = `${row.from_city} → ${row.to_city}`;
            const departureTimeText = row.departure_time.slice(0, 5);

            const emailResult = await sendDepartureReminderEmail(row.passenger_email, {
                passengerName: row.passenger_name,
                reference: row.reference,
                route: routeText,
                departureTime: departureTimeText,
                pickupTerminal: row.terminal_name,
                seatNumbers: (row.seat_numbers || "").split(", ").filter(Boolean)
            });

            await sendDepartureReminderSMS(row.passenger_phone, {
                route: routeText,
                departureTime: departureTimeText,
                pickupTerminal: row.terminal_name
            });

            // Mark as sent regardless of email success/failure — if
            // Resend genuinely failed, retrying every 5 minutes for
            // the next 2 hours would just spam the same failure.
            // A one-time attempt per booking is the right tradeoff here.
            await pool.query("UPDATE passenger_bookings SET reminder_sent_at = now() WHERE booking_id = $1", [row.booking_id]);

            if (emailResult.success) sentCount++;
        }

        res.json({ checked: result.rows.length, sent: sentCount });
    } catch (err) {
        console.error("GET /api/cron/send-departure-reminders failed:", err.message);
        res.status(500).json({ error: "Couldn't run the reminder check." });
    }
});

module.exports = router;