// =========================
// SMS SERVICE (Termii)
// =========================
// Same philosophy as email.js: every send is wrapped so a failure
// NEVER breaks the real action it's attached to (a booking, a
// cancellation, etc.) — SMS is a notification layered on top of
// something that already genuinely happened, not a gate on it.
//
// Uses Termii's shared "Termii" sender ID for now — works
// immediately, no approval needed. Once your own branded sender ID
// is approved (a separate request to Termii, takes some time), swap
// TERMII_SENDER_ID below to your approved name.

const TERMII_API_KEY = process.env.TERMII_API_KEY;
const TERMII_SENDER_ID = process.env.TERMII_SENDER_ID || "Termii";

// Termii expects Nigerian numbers in international format without
// the leading 0 or plus sign (e.g. 2348012345678). This converts
// whatever format a customer typed into that shape.
function formatNigerianNumber(phone) {
    const digits = phone.replace(/\D/g, "");

    if (digits.startsWith("234")) return digits;
    if (digits.startsWith("0")) return "234" + digits.slice(1);
    return "234" + digits;
}

async function sendSMS(to, message) {
    try {
        const response = await fetch("https://api.ng.termii.com/api/sms/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                api_key: TERMII_API_KEY,
                to: formatNigerianNumber(to),
                from: TERMII_SENDER_ID,
                sms: message,
                type: "plain",
                channel: "generic"
            })
        });

        const data = await response.json();

        if (!response.ok || data.code === "ERROR") {
            console.error(`SMS to ${to} failed:`, data.message || JSON.stringify(data));
            return { success: false, error: data.message || "SMS failed to send." };
        }

        return { success: true, error: null };
    } catch (err) {
        console.error(`SMS to ${to} failed:`, err.message);
        return { success: false, error: err.message };
    }
}

async function sendBookingReceiptSMS(to, { reference, route, price }) {
    return sendSMS(to, `FSS Transport: Payment received! ${route} - ${price}. Ref: ${reference}. Track: fss.ng/track`);
}

async function sendDepartedSMS(to, { reference, route }) {
    return sendSMS(to, `FSS Transport: Your ${route} trip has departed! Ref: ${reference}. Safe travels.`);
}

async function sendDepartureReminderSMS(to, { route, departureTime, pickupTerminal }) {
    return sendSMS(to, `FSS Transport: Reminder - your ${route} trip departs at ${departureTime} today from ${pickupTerminal}. Arrive 15-20 mins early.`);
}

async function sendCancellationSMS(to, { reference }) {
    return sendSMS(to, `FSS Transport: Booking ${reference} has been cancelled. Contact support if this wasn't you.`);
}

async function sendRefundSMS(to, { reference, amount }) {
    return sendSMS(to, `FSS Transport: A refund of ${amount} has been processed for booking ${reference}. Allow a few business days to reflect.`);
}

module.exports = {
    sendSMS,
    sendBookingReceiptSMS,
    sendDepartedSMS,
    sendDepartureReminderSMS,
    sendCancellationSMS,
    sendRefundSMS
};
