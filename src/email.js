// =========================
// EMAIL SERVICE (Resend)
// =========================
// Real email sending — replaces the "_devCode shown on screen"
// placeholder from before. Templates here are parameterized versions
// of the original static designs (email-verification.html,
// email-receipt.html, email-departed.html).
//
// IMPORTANT LIMITATION, same as documented at the top of the
// project: without verifying your own domain on Resend, the free
// tier only delivers to the exact email address you signed up with.
// Test using your own real email, not a fake one.
//
// Also: the logo URL below points at your real GitHub Pages site
// (email clients can't load local files, they need a real public
// URL) — update it if your site ever moves elsewhere.

const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = "FSS Transport <onboarding@resend.dev>"; // Resend's shared test sender — swap for your own verified domain later
const LOGO_URL = "https://tiahaleem.github.io/Fss/img/ffs_bg_removal.png";
const SITE_URL = "https://tiahaleem.github.io/Fss";

// Wraps every send with the same error handling — Resend returns
// errors as { error: {...} } rather than always throwing, so both
// cases need checking. Logs but never throws, so a failed email
// never breaks the actual booking/signup it's attached to.
async function send(to, subject, html) {
    try {
        const result = await resend.emails.send({ from: FROM_EMAIL, to, subject, html });

        if (result.error) {
            console.error(`Email to ${to} failed:`, result.error.message);
            return false;
        }

        return true;
    } catch (err) {
        console.error(`Email to ${to} failed:`, err.message);
        return false;
    }
}

function wrapper(bodyHtml) {
    return `<!DOCTYPE html><html><body style="margin:0; padding:0; background-color:#f7fafc; font-family: Arial, Helvetica, sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f7fafc; padding:30px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; overflow:hidden; max-width:600px; width:100%;">
<tr><td style="background-color:#081f5c; padding:28px 32px;">
<img src="${LOGO_URL}" alt="FSS Transport" height="32" style="display:block;">
</td></tr>
${bodyHtml}
<tr><td style="background-color:#f7fafc; padding:24px 32px; border-top:1px solid #e7edf3;">
<p style="margin:0 0 8px; color:#64748b; font-size:12px; text-align:center;">Questions? Contact <a href="mailto:hello@fss.ng" style="color:#08b6d6; text-decoration:none;">hello@fss.ng</a></p>
<p style="margin:0; color:#94a3b8; font-size:11px; text-align:center;">FSS Transport Limited · 23 Jibowu Street, Yaba, Lagos, Nigeria</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

async function sendVerificationEmail(to, code) {
    const html = wrapper(`
<tr><td style="padding:36px 32px 8px;" align="center">
<p style="margin:0 0 6px; color:#0f172a; font-size:18px; font-weight:bold;">Verify your email</p>
<p style="margin:0; color:#64748b; font-size:14px; line-height:1.6;">Enter this code to finish creating your FSS Transport account.</p>
</td></tr>
<tr><td style="padding:24px 32px;" align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:#f8fafc; border:1px dashed #d9e2ec; border-radius:12px; padding:18px 36px;">
<span style="font-size:28px; font-weight:bold; letter-spacing:6px; color:#081f5c;">${code}</span>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px;" align="center">
<p style="margin:0; color:#94a3b8; font-size:12px; line-height:1.6;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
</td></tr>
    `);

    return send(to, "Verify your email — FSS Transport", html);
}

async function sendPassengerReceiptEmail(to, { passengerName, reference, route, price, seatNumbers, pickupTerminal }) {
    const html = wrapper(`
<tr><td style="padding:32px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background-color:#f0fdf4; border-radius:12px; padding:20px 24px;">
<p style="margin:0; color:#16a34a; font-size:14px; font-weight:bold; letter-spacing:.5px;">PAYMENT RECEIVED</p>
<p style="margin:8px 0 0; color:#0f172a; font-size:22px; font-weight:bold;">${price}</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:28px 32px 0;">
<p style="margin:0 0 6px; color:#0f172a; font-size:18px; font-weight:bold;">Thanks for booking, ${passengerName}!</p>
<p style="margin:0; color:#64748b; font-size:14px; line-height:1.6;">Your payment was successful and your seat${seatNumbers.length > 1 ? 's are' : ' is'} confirmed.</p>
</td></tr>
<tr><td style="padding:24px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7edf3; border-radius:12px;">
<tr><td style="padding:16px 20px; border-bottom:1px solid #e7edf3; color:#64748b; font-size:13px;">Route</td><td style="padding:16px 20px; border-bottom:1px solid #e7edf3; color:#0f172a; font-size:13px; font-weight:bold; text-align:right;">${route}</td></tr>
<tr><td style="padding:16px 20px; border-bottom:1px solid #e7edf3; color:#64748b; font-size:13px;">Pickup</td><td style="padding:16px 20px; border-bottom:1px solid #e7edf3; color:#0f172a; font-size:13px; font-weight:bold; text-align:right;">${pickupTerminal}</td></tr>
<tr><td style="padding:16px 20px; color:#64748b; font-size:13px;">Seat${seatNumbers.length > 1 ? 's' : ''}</td><td style="padding:16px 20px; color:#0f172a; font-size:13px; font-weight:bold; text-align:right;">${seatNumbers.join(', ')}</td></tr>
</table>
</td></tr>
<tr><td style="padding:28px 32px;" align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:#08b6d6; border-radius:50px;">
<a href="${SITE_URL}/track.html?ref=${encodeURIComponent(reference)}" style="display:inline-block; padding:14px 32px; color:#ffffff; font-size:14px; font-weight:bold; text-decoration:none;">Track Your Trip</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px;">
<p style="margin:0; color:#64748b; font-size:13px; line-height:1.6; text-align:center;">Reference: <strong>${reference}</strong> — please arrive 30 minutes before departure with a valid photo ID.</p>
</td></tr>
    `);

    return send(to, `Payment received — ${reference}`, html);
}

async function sendParcelReceiptEmail(to, { senderName, reference, route, price, receiverName }) {
    const html = wrapper(`
<tr><td style="padding:32px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background-color:#f0fdf4; border-radius:12px; padding:20px 24px;">
<p style="margin:0; color:#16a34a; font-size:14px; font-weight:bold; letter-spacing:.5px;">PICKUP BOOKED</p>
<p style="margin:8px 0 0; color:#0f172a; font-size:22px; font-weight:bold;">${price}</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:28px 32px 0;">
<p style="margin:0 0 6px; color:#0f172a; font-size:18px; font-weight:bold;">Thanks, ${senderName}!</p>
<p style="margin:0; color:#64748b; font-size:14px; line-height:1.6;">Your parcel pickup is scheduled and on its way to ${receiverName}.</p>
</td></tr>
<tr><td style="padding:24px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e7edf3; border-radius:12px;">
<tr><td style="padding:16px 20px; color:#64748b; font-size:13px;">Route</td><td style="padding:16px 20px; color:#0f172a; font-size:13px; font-weight:bold; text-align:right;">${route}</td></tr>
</table>
</td></tr>
<tr><td style="padding:28px 32px;" align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:#08b6d6; border-radius:50px;">
<a href="${SITE_URL}/track.html?ref=${encodeURIComponent(reference)}" style="display:inline-block; padding:14px 32px; color:#ffffff; font-size:14px; font-weight:bold; text-decoration:none;">Track This Parcel</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:0 32px 32px;">
<p style="margin:0; color:#64748b; font-size:13px; line-height:1.6; text-align:center;">Reference: <strong>${reference}</strong></p>
</td></tr>
    `);

    return send(to, `Pickup booked — ${reference}`, html);
}

async function sendDepartedEmail(to, { passengerName, reference, route, departedTime }) {
    const html = wrapper(`
<tr><td style="padding:32px 32px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="background-color:#e0f7fa; border-radius:12px; padding:20px 24px;">
<p style="margin:0; color:#0799b3; font-size:14px; font-weight:bold; letter-spacing:.5px;">ON THE WAY</p>
<p style="margin:8px 0 0; color:#0f172a; font-size:22px; font-weight:bold;">Departed · ${departedTime}</p>
</td></tr></table>
</td></tr>
<tr><td style="padding:28px 32px 0;">
<p style="margin:0 0 6px; color:#0f172a; font-size:18px; font-weight:bold;">You're on your way, ${passengerName}!</p>
<p style="margin:0; color:#64748b; font-size:14px; line-height:1.6;">Your ${route} trip just departed. Follow the live timeline anytime.</p>
</td></tr>
<tr><td style="padding:28px 32px;" align="center">
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background-color:#08b6d6; border-radius:50px;">
<a href="${SITE_URL}/track.html?ref=${encodeURIComponent(reference)}" style="display:inline-block; padding:14px 32px; color:#ffffff; font-size:14px; font-weight:bold; text-decoration:none;">Track This Trip</a>
</td></tr></table>
</td></tr>
    `);

    return send(to, `You're on your way — ${reference}`, html);
}

module.exports = {
    sendVerificationEmail,
    sendPassengerReceiptEmail,
    sendParcelReceiptEmail,
    sendDepartedEmail
};
