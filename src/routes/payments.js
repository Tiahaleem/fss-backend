const { paymentLimiter } = require("../rateLimiters");
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

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://tiahaleem.github.io/Fss";

async function paystackRequest(path, options = {}) {
    const response = await fetch(`https://api.paystack.co${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
            "Content-Type": "application/json",
            ...options.headers
        }
    });

    const data = await response.json();

    if (!response.ok || data.status === false) {
        const err = new Error(data.message || "Paystack request failed.");
        err.status = response.status;
        throw err;
    }

    return data;
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
            `SELECT routes.price_kobo FROM trips JOIN routes ON routes.id = trips.route_id WHERE trips.id = $1`,
            [tripId]
        );

        if (tripResult.rows.length === 0) {
            return res.status(404).json({ error: "That trip doesn't exist." });
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
                ownerId: metadata.ownerId
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
                ownerId: metadata.ownerId
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

module.exports = router;
