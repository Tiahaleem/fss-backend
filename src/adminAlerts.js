// =========================
// ADMIN BOOKING ALERTS
// =========================
// Emails the company (not the customer) whenever a booking is made,
// cancelled or refunded, with every detail needed so nobody has to
// keep checking the admin page.
//
// Never throws, and callers don't await it — a failed alert email
// must never get in the way of a customer's booking.

const pool = require("./db");
const { sendAdminBookingAlertEmail } = require("./email");

const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || "fsstransportltd@gmail.com";

async function loadBooking(reference) {
    const result = await pool.query(
        `SELECT
            b.reference, b.type, b.status, b.price_kobo, b.created_at,
            pb.passenger_name, pb.passenger_phone, pb.passenger_email,
            to_char(pb.travel_date, 'YYYY-MM-DD') AS travel_date,
            t.departure_time,
            term.name AS terminal_name,
            (SELECT string_agg(seat_number, ', ' ORDER BY seat_number) FROM seat_holds WHERE booking_id = b.id) AS seat_numbers,
            pab.sender_name, pab.sender_phone, pab.sender_email,
            pab.receiver_name, pab.receiver_phone,
            pab.description, pab.weight_kg, pab.declared_value_kobo,
            COALESCE(pab.from_city, r.from_city) AS from_city,
            COALESCE(pab.to_city, r.to_city) AS to_city
         FROM bookings b
         LEFT JOIN passenger_bookings pb ON pb.booking_id = b.id
         LEFT JOIN parcel_bookings pab ON pab.booking_id = b.id
         LEFT JOIN trips t ON t.id = pb.trip_id
         LEFT JOIN routes r ON r.id = t.route_id
         LEFT JOIN terminals term ON term.id = pb.terminal_id
         WHERE b.reference = $1`,
        [reference]
    );

    return result.rows[0] || null;
}

// event: "new" | "cancelled" | "refunded"
async function notifyAdminBooking(reference, event) {
    try {
        const booking = await loadBooking(reference);
        if (!booking) return;

        await sendAdminBookingAlertEmail(ADMIN_ALERT_EMAIL, { booking, event });
    } catch (err) {
        console.error(`Admin booking alert for ${reference} failed:`, err.message);
    }
}

module.exports = { notifyAdminBooking };
