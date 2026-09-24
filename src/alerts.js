// =========================
// ERROR ALERTS
// =========================
// Emails the admin directly whenever something genuinely breaks on
// the server — the same real email service (Resend) already used
// for everything else, no new account or service needed.
//
// Rate-limited per distinct error message: if the same bug keeps
// firing every second, this sends ONE alert and then stays quiet
// about that specific error for a while, rather than flooding the
// inbox with hundreds of identical emails.

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = "FSS Transport <noreply@fsstransport.com.ng>";
const ADMIN_ALERT_EMAIL = process.env.ADMIN_ALERT_EMAIL || "fsstranportltd@gmail.com";
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes per distinct error message

const lastAlertedAt = new Map();

function shouldAlert(key) {
    const last = lastAlertedAt.get(key);
    const now = Date.now();

    if (last && now - last < COOLDOWN_MS) {
        return false; // already alerted about this recently — stay quiet
    }

    lastAlertedAt.set(key, now);
    return true;
}

async function sendErrorAlert(context, error) {
    // Never let a failure in the ALERTING system itself crash
    // anything or throw — this is a side-channel notification, not
    // something the app should ever depend on.
    try {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const alertKey = `${context}: ${errorMessage}`;

        if (!shouldAlert(alertKey)) return;

        const stack = error instanceof Error && error.stack ? error.stack : "(no stack trace available)";
        const timestamp = new Date().toISOString();

        await resend.emails.send({
            from: FROM_EMAIL,
            to: ADMIN_ALERT_EMAIL,
            subject: `⚠️ FSS Transport server error: ${context}`,
            html: `
                <div style="font-family: monospace; padding: 20px; background: #fff5f5; border-left: 4px solid #dc2626;">
                    <p style="margin:0 0 12px; font-weight:bold; color:#991b1b;">A server error just occurred.</p>
                    <p style="margin:0 0 4px;"><strong>Where:</strong> ${context}</p>
                    <p style="margin:0 0 4px;"><strong>When:</strong> ${timestamp}</p>
                    <p style="margin:0 0 4px;"><strong>Message:</strong> ${errorMessage}</p>
                    <pre style="margin:12px 0 0; padding:12px; background:#fee2e2; border-radius:6px; white-space:pre-wrap; font-size:12px;">${stack}</pre>
                </div>
                <p style="font-family: sans-serif; font-size: 13px; color: #64748b; margin-top: 16px;">
                    You won't get another alert for this exact same error for 30 minutes, even if it keeps happening — this just stops your inbox from flooding if something breaks repeatedly.
                </p>
            `
        });
    } catch (alertErr) {
        // Genuinely nothing more to do here — logging is the only
        // fallback if the alert itself can't be sent (e.g. Resend
        // is down too).
        console.error("Failed to send error alert email:", alertErr);
    }
}

module.exports = { sendErrorAlert };
