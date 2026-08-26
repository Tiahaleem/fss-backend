// =========================
// PAYSTACK REQUEST HELPER (shared)
// =========================
// Extracted out of payments.js so both the payment flow AND refunds
// (in bookings.js) can call Paystack the same consistent way.

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

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

module.exports = { paystackRequest };
