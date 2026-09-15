// =========================
// FLUTTERWAVE REQUEST HELPER (shared)
// =========================
// Same pattern as paystack.js — one shared function both the payment
// flow and refunds can call, so the auth header and error handling
// only live in one place.

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

async function flutterwaveRequest(path, options = {}) {
    const response = await fetch(`https://api.flutterwave.com/v3${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${FLW_SECRET_KEY}`,
            "Content-Type": "application/json",
            ...options.headers
        }
    });

    const data = await response.json();

    if (!response.ok || data.status === "error") {
        const err = new Error(data.message || "Flutterwave request failed.");
        err.status = response.status;
        throw err;
    }

    return data;
}

// Flutterwave doesn't generate a reference for us the way Paystack
// does — we have to make one up ourselves, before ever calling them.
function generateTxRef() {
    return `FLW-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
}

module.exports = { flutterwaveRequest, generateTxRef };
