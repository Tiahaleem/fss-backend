// =========================
// BOOKING CREATORS (shared)
// =========================
// The actual "create a real booking" logic, extracted so it can be
// called from two places: the direct admin-only POST endpoints in
// bookings.js (for manual/support bookings), AND the payment
// verification flow in payments.js (for real customer payments) —
// both need the exact same transactional guarantees, so there's one
// copy of this logic, not two.

const pool = require("./db");
const { sendPassengerReceiptEmail, sendParcelReceiptEmail } = require("./email");
const { sendBookingReceiptSMS } = require("./sms");

function generateReference(prefix) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = prefix + "-";
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

async function createPassengerBooking({
    tripId, terminalId, seatNumbers, sessionId,
    passengerName, passengerEmail, passengerPhone, travelDate, ownerId, paymentReference
}) {
    if (!tripId || !terminalId || !Array.isArray(seatNumbers) || seatNumbers.length === 0 ||
        !passengerName || !passengerEmail || !passengerPhone || !travelDate) {
        const err = new Error("Missing required booking details — seatNumbers must be a non-empty array.");
        err.status = 400;
        throw err;
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const tripResult = await client.query(
            `SELECT trips.id, routes.price_kobo, routes.from_city, routes.to_city
             FROM trips JOIN routes ON routes.id = trips.route_id
             WHERE trips.id = $1`,
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            await client.query("ROLLBACK");
            const err = new Error("That trip doesn't exist.");
            err.status = 404;
            throw err;
        }

        const pricePerSeatKobo = tripResult.rows[0].price_kobo;
        const totalPriceKobo = pricePerSeatKobo * seatNumbers.length;
        const reference = generateReference("FSS");

        const bookingResult = await client.query(
            `INSERT INTO bookings (reference, type, owner_id, price_kobo, payment_reference)
             VALUES ($1, 'passenger', $2, $3, $4)
             RETURNING id, created_at`,
            [reference, ownerId || null, totalPriceKobo, paymentReference || null]
        );
        const bookingId = bookingResult.rows[0].id;

        await client.query(
            `INSERT INTO passenger_bookings
                (booking_id, trip_id, terminal_id, passenger_name, passenger_email, passenger_phone, travel_date)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [bookingId, tripId, terminalId, passengerName, passengerEmail, passengerPhone, travelDate]
        );

        for (const seatNumber of seatNumbers) {
            await client.query(
                `INSERT INTO seat_holds (trip_id, travel_date, seat_number, status, booking_id, expires_at)
                 VALUES ($1, $2, $3, 'booked', $4, NULL)
                 ON CONFLICT (trip_id, travel_date, seat_number)
                 DO UPDATE SET status = 'booked', booking_id = $4, held_by_session = NULL, expires_at = NULL
                 WHERE seat_holds.status = 'held' AND seat_holds.held_by_session = $5`,
                [tripId, travelDate, seatNumber, bookingId, sessionId || null]
            );

            const seatCheck = await client.query(
                `SELECT booking_id FROM seat_holds WHERE trip_id = $1 AND travel_date = $2 AND seat_number = $3`,
                [tripId, travelDate, seatNumber]
            );

            if (!seatCheck.rows[0] || seatCheck.rows[0].booking_id !== bookingId) {
                await client.query("ROLLBACK");
                const err = new Error(`Seat ${seatNumber} was just taken by someone else. Please pick again.`);
                err.status = 409;
                throw err;
            }
        }

        await client.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES
                ($1, 1, 'Booking confirmed', to_char(now(), 'HH24:MI'), 'completed', 'boarding'),
                ($1, 2, 'Awaiting boarding', to_char(now(), 'HH24:MI'), 'active', 'location')`,
            [bookingId]
        );

        await client.query("COMMIT");

        const terminalNameResult = await pool.query("SELECT name FROM terminals WHERE id = $1", [terminalId]);

        const routeText = `${tripResult.rows[0].from_city} → ${tripResult.rows[0].to_city}`;
        const priceText = `₦${(totalPriceKobo / 100).toLocaleString()}`;

        const emailResult = await sendPassengerReceiptEmail(passengerEmail, {
            passengerName,
            reference,
            route: routeText,
            price: priceText,
            seatNumbers,
            pickupTerminal: terminalNameResult.rows[0]?.name || "your pickup terminal"
        });

        const smsResult = await sendBookingReceiptSMS(passengerPhone, {
            reference,
            route: routeText,
            price: priceText
        });

        return { reference, bookingId, priceKobo: totalPriceKobo, seatCount: seatNumbers.length, emailResult, smsResult };
    } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

async function createParcelBooking({
    fromCity, toCity, senderName, senderPhone, senderEmail,
    receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo, ownerId, paymentReference
}) {
    if (!fromCity || !toCity || !senderName || !senderPhone || !senderEmail || !receiverName || !receiverPhone || !description || !weightKg) {
        const err = new Error("Missing required parcel details.");
        err.status = 400;
        throw err;
    }

    const client = await pool.connect();

    try {
        await client.query("BEGIN");

        const reference = generateReference("PCL");

        const bookingResult = await client.query(
            `INSERT INTO bookings (reference, type, owner_id, price_kobo, payment_reference)
             VALUES ($1, 'parcel', $2, $3, $4)
             RETURNING id`,
            [reference, ownerId || null, priceKobo || 0, paymentReference || null]
        );
        const bookingId = bookingResult.rows[0].id;

        await client.query(
            `INSERT INTO parcel_bookings
                (booking_id, from_city, to_city, sender_name, sender_phone, sender_email, receiver_name, receiver_phone, description, weight_kg, declared_value_kobo)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [bookingId, fromCity, toCity, senderName, senderPhone, senderEmail, receiverName, receiverPhone, description, weightKg, declaredValueKobo || 0]
        );

        await client.query(
            `INSERT INTO tracking_events (booking_id, sort_order, title, event_time, status, icon)
             VALUES ($1, 1, 'Pickup scheduled', to_char(now(), 'HH24:MI'), 'active', 'boarding')`,
            [bookingId]
        );

        await client.query("COMMIT");

        const parcelRouteText = `${fromCity} → ${toCity}`;
        const parcelPriceText = `₦${((priceKobo || 0) / 100).toLocaleString()}`;

        const emailResult = await sendParcelReceiptEmail(senderEmail, {
            senderName,
            reference,
            route: parcelRouteText,
            price: parcelPriceText,
            receiverName
        });

        const smsResult = await sendBookingReceiptSMS(senderPhone, {
            reference,
            route: parcelRouteText,
            price: parcelPriceText
        });

        return { reference, bookingId, emailResult, smsResult };
    } catch (err) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

module.exports = { createPassengerBooking, createParcelBooking };