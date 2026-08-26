// =========================
// RATE LIMITERS
// =========================
// Different endpoints get different limits based on how much damage
// someone could do by hammering them repeatedly. A stranger guessing
// passwords needs a much tighter limit than someone just browsing
// routes.
//
// Limits are per IP address. A legitimate person will basically
// never notice these — they're sized around "how many times would a
// real person plausibly do this in the given window," not around
// typical everyday use.

const rateLimit = require("express-rate-limit");

function makeLimiter(windowMinutes, max, message) {
    return rateLimit({
        windowMs: windowMinutes * 60 * 1000,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: message }
    });
}

// Login — the classic brute-force target. 5 tries per 15 minutes is
// plenty for someone who mistyped their password a couple of times,
// but stops someone trying thousands of password guesses.
const loginLimiter = makeLimiter(15, 5, "Too many login attempts. Please wait a few minutes and try again.");

// Signup — stops a script from mass-creating fake accounts.
const signupLimiter = makeLimiter(60, 5, "Too many accounts created from this connection. Please try again later.");

// Verification code — someone could otherwise try to brute-force all
// 1,000,000 possible 6-digit codes for a real pending signup.
const verifyLimiter = makeLimiter(15, 10, "Too many attempts. Please wait a few minutes and try again.");

// Resend code — stops someone repeatedly triggering emails to
// harass an address, or burning through your email sending quota.
const resendLimiter = makeLimiter(15, 3, "Please wait a few minutes before requesting another code.");

// Starting a payment — a real checkout happens once per booking;
// this just stops automated abuse of the Paystack integration.
const paymentLimiter = makeLimiter(15, 10, "Too many payment attempts. Please wait a few minutes and try again.");

// A generous baseline for every other request — mainly a safety net
// against basic scraping/abuse, not meant to affect real usage at all.
const generalLimiter = makeLimiter(15, 300, "Too many requests. Please slow down and try again shortly.");

module.exports = { loginLimiter, signupLimiter, verifyLimiter, resendLimiter, paymentLimiter, generalLimiter };
