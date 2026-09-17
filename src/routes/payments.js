// =========================
// PAYMENTS API (Paystack)
// =========================
// The real gate between "customer clicked Pay" and "a booking
// actually gets created". Two steps:
//   1. initialize — tells Paystack "start a transaction for this
//      amount", gets back a checkout URL to send the customer to.
//      The booking details ride along as Paystack's own "metadata"
//      field — Paystack hands them straight back to us on verify,
//      so nothing needs to be stored in our own database in the
//      meantime.
//   2. verify — after Paystack redirects the customer back, THIS is
//      the step that actually checks with Paystack directly whether
//      the payment really succeeded. Only then does the real booking
//      get created. The redirect alone proves nothing — it's just a
//      browser navigating; a real check has to happen server-to-server.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { optionalAuth } = require("../middleware/requireAuth");
const { createPassengerBooking, createParcelBooking } = require("../bookingCreators");
const { paystackRequest } = require("../paystack");
const { flutterwaveRequest, generateTxRef } = require("../flutterwave");
const { paymentLimiter } = require("../rateLimiters");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://tiahaleem.github.io/Fss";

// Checks whether a trip's departure (this specific date + its daily
// departure time) has already passed. A trip that departs at 6am is
// perfectly bookable for tomorrow even at 11pm tonight — this only
// blocks the exact date+time combination that's genuinely already gone.
function hasTripDeparted(departureTime, travelDate) {
    const [hours, minutes] = departureTime.split(":").map(Number);
    const [year, month, day] = travelDate.split("-").map(Number);
    const departureDatetime = new Date(year, month - 1, day, hours, minutes);
    return departureDatetime <= new Date();
}

// =========================
// POST /api/payments/initialize-passenger
// =========================
router.post("/initialize-passenger", paymentLimiter, optionalAuth, async (req, res) => {
    try {
        const { tripId, terminalId, seatNumbers, sessionId, passengerName, passengerEmail, passengerPhone, travelDate } = req.body;

        if (!tripId || !terminalId || !Array.isArray(seatNumbers) || seatNumbers.length === 0 || !passengerEmail) {
            return res.status(400).json({ error: "Missing required booking details." });
        }

        // Look up the real price server-side — never trust an amount
        // sent from the browser for what to actually charge.
        const tripResult = await pool.query(
            `SELECT routes.price_kobo, trips.departure_time FROM trips JOIN routes ON routes.id = trips.route_id WHERE trips.id = $1`,
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            return res.status(404).json({ error: "That trip doesn't exist." });
        }

        if (hasTripDeparted(tripResult.rows[0].departure_time, travelDate)) {
            return res.status(400).json({ error: "This trip has already departed for the selected date. Please choose a different date or trip." });
        }

        const totalKobo = tripResult.rows[0].price_kobo * seatNumbers.length;

        const paystackResponse = await paystackRequest("/transaction/initialize", {
            method: "POST",
            body: JSON.stringify({
                email: passengerEmail,
                amount: totalKobo, // Paystack expects the smallest currency unit — kobo, matching our schema exactly
                callback_url: `${FRONTEND_URL}/payment-callback.html`,
                metadata: {
                    bookingType: "passenger",
                    tripId, terminalId, seatNumbers, sessionId,
                    passengerName, passengerEmail, passengerPhone, travelDate,
                    ownerId: req.user ? req.user.id : null
                }
            })
        });

        res.json({
            authorizationUrl: paystackResponse.data.authorization_url,
            reference: paystackResponse.data.reference
        });
    } catch (err) {
        console.error("POST /api/payments/initialize-passenger failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't start payment." });
    }
});

// =========================
// POST /api/payments/initialize-parcel
// =========================
router.post("/initialize-parcel", paymentLimiter, optionalAuth, async (req, res) => {
    try {
        const {
            fromCity, toCity, senderName, senderPhone, senderEmail,
            receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo
        } = req.body;

        if (!fromCity || !toCity || !senderEmail || !priceKobo) {
            return res.status(400).json({ error: "Missing required parcel details." });
        }

        const paystackResponse = await paystackRequest("/transaction/initialize", {
            method: "POST",
            body: JSON.stringify({
                email: senderEmail,
                amount: priceKobo,
                callback_url: `${FRONTEND_URL}/payment-callback.html`,
                metadata: {
                    bookingType: "parcel",
                    fromCity, toCity, senderName, senderPhone, senderEmail,
                    receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo,
                    ownerId: req.user ? req.user.id : null
                }
            })
        });

        res.json({
            authorizationUrl: paystackResponse.data.authorization_url,
            reference: paystackResponse.data.reference
        });
    } catch (err) {
        console.error("POST /api/payments/initialize-parcel failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't start payment." });
    }
});

// =========================
// GET /api/payments/verify/:reference
// =========================
// The one function that actually matters for security here: checks
// DIRECTLY with Paystack (server-to-server, using the secret key)
// whether a payment genuinely succeeded, then — and only then —
// creates the real booking using the metadata Paystack hands back.
router.get("/verify/:reference", async (req, res) => {
    try {
        const paystackResponse = await paystackRequest(`/transaction/verify/${encodeURIComponent(req.params.reference)}`);
        const transaction = paystackResponse.data;

        if (transaction.status !== "success") {
            return res.status(402).json({ error: "Payment was not successful.", paystackStatus: transaction.status });
        }

        const metadata = transaction.metadata;

        if (!metadata || !metadata.bookingType) {
            return res.status(400).json({ error: "Payment succeeded but booking details are missing. Contact support with your payment reference." });
        }

        let bookingResult;

        if (metadata.bookingType === "passenger") {
            bookingResult = await createPassengerBooking({
                tripId: metadata.tripId,
                terminalId: metadata.terminalId,
                seatNumbers: metadata.seatNumbers,
                sessionId: metadata.sessionId,
                passengerName: metadata.passengerName,
                passengerEmail: metadata.passengerEmail,
                passengerPhone: metadata.passengerPhone,
                travelDate: metadata.travelDate,
                ownerId: metadata.ownerId,
                paymentReference: transaction.reference
            });
        } else if (metadata.bookingType === "parcel") {
            bookingResult = await createParcelBooking({
                fromCity: metadata.fromCity,
                toCity: metadata.toCity,
                senderName: metadata.senderName,
                senderPhone: metadata.senderPhone,
                senderEmail: metadata.senderEmail,
                receiverName: metadata.receiverName,
                receiverPhone: metadata.receiverPhone,
                description: metadata.description,
                weightKg: metadata.weightKg,
                declaredValueKobo: metadata.declaredValueKobo,
                priceKobo: metadata.priceKobo,
                ownerId: metadata.ownerId,
                paymentReference: transaction.reference
            });
        } else {
            return res.status(400).json({ error: "Unknown booking type in payment metadata." });
        }

        res.json({ paymentVerified: true, ...bookingResult });
    } catch (err) {
        console.error("GET /api/payments/verify failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't verify that payment." });
    }
});

// =========================
// FLUTTERWAVE — same pattern as above, different provider
// =========================
// Key differences from Paystack worth remembering:
//   - Flutterwave charges in NAIRA, not kobo — every amount gets
//     divided by 100 before being sent.
//   - Flutterwave doesn't generate a reference for us — we make one
//     up (generateTxRef) before ever calling them.
//   - Booking details ride along in Flutterwave's "meta" field,
//     same idea as Paystack's "metadata".

// =========================
// POST /api/payments/flutterwave/initialize-passenger
// =========================
router.post("/flutterwave/initialize-passenger", paymentLimiter, optionalAuth, async (req, res) => {
    try {
        const { tripId, terminalId, seatNumbers, sessionId, passengerName, passengerEmail, passengerPhone, travelDate } = req.body;

        if (!tripId || !terminalId || !Array.isArray(seatNumbers) || seatNumbers.length === 0 || !passengerEmail) {
            return res.status(400).json({ error: "Missing required booking details." });
        }

        const tripResult = await pool.query(
            `SELECT routes.price_kobo, trips.departure_time FROM trips JOIN routes ON routes.id = trips.route_id WHERE trips.id = $1`,
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            return res.status(404).json({ error: "That trip doesn't exist." });
        }

        if (hasTripDeparted(tripResult.rows[0].departure_time, travelDate)) {
            return res.status(400).json({ error: "This trip has already departed for the selected date. Please choose a different date or trip." });
        }

        const totalKobo = tripResult.rows[0].price_kobo * seatNumbers.length;
        const txRef = generateTxRef();

        const flwResponse = await flutterwaveRequest("/payments", {
            method: "POST",
            body: JSON.stringify({
                tx_ref: txRef,
                amount: totalKobo / 100, // Flutterwave wants Naira, not kobo
                currency: "NGN",
                redirect_url: `${FRONTEND_URL}/payment-callback.html`,
                customer: {
                    email: passengerEmail,
                    phonenumber: passengerPhone,
                    name: passengerName
                },
                customizations: { title: "FSS Transport" },
                meta: {
                    bookingType: "passenger",
                    tripId, terminalId,
                    seatNumbers: seatNumbers.join(","), // Flutterwave's meta rejects arrays — flattened to a string
                    sessionId: sessionId || "",
                    passengerName, passengerEmail, passengerPhone, travelDate,
                    ownerId: req.user ? req.user.id : "" // Flutterwave's meta rejects null too
                }
            })
        });

        res.json({
            authorizationUrl: flwResponse.data.link,
            reference: txRef
        });
    } catch (err) {
        console.error("POST /api/payments/flutterwave/initialize-passenger failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't start payment." });
    }
});

// =========================
// POST /api/payments/flutterwave/initialize-parcel
// =========================
router.post("/flutterwave/initialize-parcel", paymentLimiter, optionalAuth, async (req, res) => {
    try {
        const {
            fromCity, toCity, senderName, senderPhone, senderEmail,
            receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo
        } = req.body;

        if (!fromCity || !toCity || !senderEmail || !priceKobo) {
            return res.status(400).json({ error: "Missing required parcel details." });
        }

        const txRef = generateTxRef();

        const flwResponse = await flutterwaveRequest("/payments", {
            method: "POST",
            body: JSON.stringify({
                tx_ref: txRef,
                amount: priceKobo / 100,
                currency: "NGN",
                redirect_url: `${FRONTEND_URL}/payment-callback.html`,
                customer: {
                    email: senderEmail,
                    phonenumber: senderPhone,
                    name: senderName
                },
                customizations: { title: "FSS Transport" },
                meta: {
                    bookingType: "parcel",
                    fromCity, toCity, senderName, senderPhone, senderEmail,
                    receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo,
                    ownerId: req.user ? req.user.id : ""
                }
            })
        });

        res.json({
            authorizationUrl: flwResponse.data.link,
            reference: txRef
        });
    } catch (err) {
        console.error("POST /api/payments/flutterwave/initialize-parcel failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't start payment." });
    }
});

// =========================
// GET /api/payments/flutterwave/verify/:txRef
// =========================
router.get("/flutterwave/verify/:txRef", async (req, res) => {
    try {
        const flwResponse = await flutterwaveRequest(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(req.params.txRef)}`);
        const transaction = flwResponse.data;

        if (transaction.status !== "successful") {
            return res.status(402).json({ error: "Payment was not successful.", flutterwaveStatus: transaction.status });
        }

        // Same failsafe Flutterwave's own docs recommend: don't just
        // trust "successful" — confirm the currency actually matches
        // what was expected (this system only ever charges in Naira).
        if (transaction.currency !== "NGN") {
            return res.status(402).json({ error: "Payment currency didn't match what was expected." });
        }

        const metadata = transaction.meta;

        if (!metadata || !metadata.bookingType) {
            return res.status(400).json({ error: "Payment succeeded but booking details are missing. Contact support with your payment reference." });
        }

        let bookingResult;

        if (metadata.bookingType === "passenger") {
            bookingResult = await createPassengerBooking({
                tripId: metadata.tripId,
                terminalId: metadata.terminalId,
                seatNumbers: metadata.seatNumbers.split(","), // reverses the join(",") done at initialize time
                sessionId: metadata.sessionId || null,
                passengerName: metadata.passengerName,
                passengerEmail: metadata.passengerEmail,
                passengerPhone: metadata.passengerPhone,
                travelDate: metadata.travelDate,
                ownerId: metadata.ownerId || null,
                paymentReference: transaction.tx_ref
            });
        } else if (metadata.bookingType === "parcel") {
            bookingResult = await createParcelBooking({
                fromCity: metadata.fromCity,
                toCity: metadata.toCity,
                senderName: metadata.senderName,
                senderPhone: metadata.senderPhone,
                senderEmail: metadata.senderEmail,
                receiverName: metadata.receiverName,
                receiverPhone: metadata.receiverPhone,
                description: metadata.description,
                weightKg: metadata.weightKg,
                declaredValueKobo: metadata.declaredValueKobo,
                priceKobo: metadata.priceKobo,
                ownerId: metadata.ownerId || null,
                paymentReference: transaction.tx_ref
            });
        } else {
            return res.status(400).json({ error: "Unknown booking type in payment metadata." });
        }

        res.json({ paymentVerified: true, ...bookingResult });
    } catch (err) {
        console.error("GET /api/payments/flutterwave/verify failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't verify that payment." });
    }
});

module.exports = router;
