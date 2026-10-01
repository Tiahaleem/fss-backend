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
const { validatePromoCode } = require("./promo-codes");
const { paymentLimiter } = require("../rateLimiters");

const FRONTEND_URL = process.env.FRONTEND_URL || "https://tiahaleem.github.io/Fss";

// Checks whether a trip's departure (this specific date + its daily
// departure time) has already passed. A trip that departs at 6am is
// perfectly bookable for tomorrow even at 11pm tonight — this only
// blocks the exact date+time combination that's genuinely already gone.
// departure_time is always entered and understood as West Africa
// Time (this business operates in Nigeria) — regardless of what
// timezone the server itself happens to run in. Building this as a
// genuine UTC timestamp (WAT is UTC+1, so subtract 1 hour) means the
// comparison against real "now" is correct no matter where this
// code is actually hosted.
function hasTripDeparted(departureTime, travelDate) {
    const [hours, minutes] = departureTime.split(":").map(Number);
    const [year, month, day] = travelDate.split("-").map(Number);
    const departureDatetime = new Date(Date.UTC(year, month - 1, day, hours, minutes) - 60 * 60 * 1000);
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
        const { tripId, terminalId, seatNumbers, sessionId, passengerName, passengerEmail, passengerPhone, travelDate, promoCode } = req.body;

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

        const baseTotalKobo = tripResult.rows[0].price_kobo * seatNumbers.length;

        // Every discount here is computed server-side, in a fixed
        // order, each only ever reducing what's left — never trusted
        // from anything the customer's browser claims.
        let totalKobo = baseTotalKobo;
        let appliedPromoId = null;
        let referralBonusAppliedKobo = 0;
        let referralCreditAppliedKobo = 0;

        if (promoCode) {
            const promoResult = await validatePromoCode(promoCode, baseTotalKobo);
            if (!promoResult.valid) {
                return res.status(400).json({ error: promoResult.error });
            }
            totalKobo = promoResult.finalAmountKobo;
            appliedPromoId = promoResult.promoId;
        }

        // Referral perks only ever apply to a logged-in, identified
        // customer — a guest checkout has no account to track "has
        // this person already used their referral bonus" against.
        if (req.user) {
            const userResult = await pool.query(
                "SELECT referred_by_user_id, referral_bonus_used, referral_credit_kobo FROM users WHERE id = $1",
                [req.user.id]
            );
            const user = userResult.rows[0];

            if (user) {
                // The one-time discount for being someone's referral,
                // on their very first booking only.
                if (user.referred_by_user_id && !user.referral_bonus_used) {
                    const settingResult = await pool.query("SELECT value FROM site_settings WHERE key = 'referral_discount_kobo'");
                    const referralDiscountKobo = Number(settingResult.rows[0]?.value || 0);
                    referralBonusAppliedKobo = Math.min(referralDiscountKobo, totalKobo);
                    totalKobo -= referralBonusAppliedKobo;
                }

                // Any earned credit from referring others, applied on
                // top of everything else.
                if (user.referral_credit_kobo > 0) {
                    referralCreditAppliedKobo = Math.min(user.referral_credit_kobo, totalKobo);
                    totalKobo -= referralCreditAppliedKobo;
                }
            }
        }

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
                    ownerId: req.user ? req.user.id : "", // Flutterwave's meta rejects null too
                    appliedPromoId: appliedPromoId || "",
                    referralBonusApplied: referralBonusAppliedKobo > 0 ? "true" : "",
                    referralCreditAppliedKobo: referralCreditAppliedKobo || ""
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
            receiverName, receiverPhone, description, weightKg, declaredValueKobo, priceKobo, promoCode
        } = req.body;

        if (!fromCity || !toCity || !senderEmail || !priceKobo) {
            return res.status(400).json({ error: "Missing required parcel details." });
        }

        let finalPriceKobo = priceKobo;
        let appliedPromoId = null;

        if (promoCode) {
            const promoResult = await validatePromoCode(promoCode, priceKobo);
            if (!promoResult.valid) {
                return res.status(400).json({ error: promoResult.error });
            }
            finalPriceKobo = promoResult.finalAmountKobo;
            appliedPromoId = promoResult.promoId;
        }

        const txRef = generateTxRef();

        const flwResponse = await flutterwaveRequest("/payments", {
            method: "POST",
            body: JSON.stringify({
                tx_ref: txRef,
                amount: finalPriceKobo / 100,
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
                    ownerId: req.user ? req.user.id : "",
                    appliedPromoId: appliedPromoId || ""
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

// The actual real verification + booking creation work. Shared by
// the browser-redirect endpoint below AND the webhook — whichever
// one reaches Flutterwave and gets back "successful" first does the
// real work; the other one safely no-ops once it sees a booking
// already exists for this exact payment reference. This idempotency
// check is what makes it safe for both paths to race each other.
async function verifyAndCreateBooking(txRef) {
    const existingBooking = await pool.query(
        "SELECT reference FROM bookings WHERE payment_reference = $1",
        [txRef]
    );
    if (existingBooking.rows.length > 0) {
        return { reference: existingBooking.rows[0].reference, alreadyProcessed: true };
    }

    const flwResponse = await flutterwaveRequest(`/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    const transaction = flwResponse.data;

    if (transaction.status !== "successful") {
        const err = new Error("Payment was not successful.");
        err.status = 402;
        err.flutterwaveStatus = transaction.status;
        throw err;
    }

    // Same failsafe Flutterwave's own docs recommend: don't just
    // trust "successful" — confirm the currency actually matches
    // what was expected (this system only ever charges in Naira).
    if (transaction.currency !== "NGN") {
        const err = new Error("Payment currency didn't match what was expected.");
        err.status = 402;
        throw err;
    }

    const metadata = transaction.meta;

    if (!metadata || !metadata.bookingType) {
        const err = new Error("Payment succeeded but booking details are missing. Contact support with your payment reference.");
        err.status = 400;
        throw err;
    }

    // Flutterwave's own confirmed amount is the authoritative
    // record of what was genuinely charged — this already
    // reflects any promo discount applied at checkout, straight
    // from the payment provider itself rather than something
    // reconstructed on our end.
    const confirmedAmountKobo = Math.round(Number(transaction.amount) * 100);

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
            paymentReference: transaction.tx_ref,
            overridePriceKobo: confirmedAmountKobo
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
            priceKobo: confirmedAmountKobo,
            ownerId: metadata.ownerId || null,
            paymentReference: transaction.tx_ref
        });
    } else {
        const err = new Error("Unknown booking type in payment metadata.");
        err.status = 400;
        throw err;
    }

    // Only counts as a real use once payment has genuinely gone
    // through — an abandoned checkout with a code typed in never
    // consumes it.
    if (metadata.appliedPromoId) {
        await pool.query("UPDATE promo_codes SET times_used = times_used + 1 WHERE id = $1", [metadata.appliedPromoId]);
    }

    // Same idea for referral perks — only a genuinely completed
    // payment actually spends the credit or marks the one-time
    // bonus used, never an abandoned attempt.
    if (metadata.referralCreditAppliedKobo && metadata.ownerId) {
        await pool.query(
            "UPDATE users SET referral_credit_kobo = referral_credit_kobo - $1 WHERE id = $2",
            [Number(metadata.referralCreditAppliedKobo), metadata.ownerId]
        );
    }

    if (metadata.referralBonusApplied === "true" && metadata.ownerId) {
        const referredUserResult = await pool.query(
            "UPDATE users SET referral_bonus_used = true WHERE id = $1 RETURNING referred_by_user_id",
            [metadata.ownerId]
        );

        const referrerId = referredUserResult.rows[0]?.referred_by_user_id;
        if (referrerId) {
            const settingResult = await pool.query("SELECT value FROM site_settings WHERE key = 'referral_reward_kobo'");
            const rewardKobo = Number(settingResult.rows[0]?.value || 0);

            if (rewardKobo > 0) {
                await pool.query(
                    "UPDATE users SET referral_credit_kobo = referral_credit_kobo + $1 WHERE id = $2",
                    [rewardKobo, referrerId]
                );
            }
        }
    }

    return bookingResult;
}

// =========================
// GET /api/payments/flutterwave/verify/:txRef
// =========================
router.get("/flutterwave/verify/:txRef", async (req, res) => {
    try {
        const bookingResult = await verifyAndCreateBooking(req.params.txRef);
        res.json({ paymentVerified: true, ...bookingResult });
    } catch (err) {
        console.error("GET /api/payments/flutterwave/verify failed:", err.message);
        res.status(err.status || 500).json({ error: err.message || "Couldn't verify that payment.", flutterwaveStatus: err.flutterwaveStatus });
    }
});

// =========================
// POST /api/payments/flutterwave/webhook
// =========================
// An independent, server-to-server notification straight from
// Flutterwave the moment a payment succeeds — separate from whether
// the customer's browser ever makes it back to the redirect page.
// Without this, a customer who pays but then loses their connection,
// closes their browser too early, or has the redirect itself fail
// for any reason could have genuinely paid with no booking ever
// created. This exists purely as a safety net alongside the redirect
// flow above — whichever one gets there first does the real work.
router.post("/flutterwave/webhook", async (req, res) => {
    try {
        // Flutterwave sends back the exact secret string configured
        // in the dashboard, verbatim, in this header — a simple
        // shared-secret check, not a computed signature. Without
        // this, anyone could POST a fake payload claiming a payment
        // succeeded.
        const signature = req.headers["verif-hash"];
        if (!signature || !process.env.FLW_WEBHOOK_SECRET_HASH || signature !== process.env.FLW_WEBHOOK_SECRET_HASH) {
            return res.status(401).json({ error: "Invalid webhook signature." });
        }

        const txRef = req.body?.data?.tx_ref;
        if (!txRef) {
            return res.status(400).json({ error: "No tx_ref in webhook payload." });
        }

        // The webhook body itself is NEVER trusted for the actual
        // transaction details — verifyAndCreateBooking independently
        // re-fetches the real, current state straight from
        // Flutterwave's own servers using just this reference.
        await verifyAndCreateBooking(txRef);

        res.status(200).json({ received: true });
    } catch (err) {
        // Logged (and therefore alerted on, via the existing error
        // alert system) rather than thrown — Flutterwave expects a
        // fast 200 acknowledging receipt regardless, and retries
        // aggressively on anything else, which would just repeat
        // whatever genuinely failed.
        console.error("POST /api/payments/flutterwave/webhook failed:", err.message);
        res.status(200).json({ received: true, processingError: err.message });
    }
});

module.exports = router;
