const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// GOOGLE SHEET API (admin only)
// =========================
// Powers the "Sync to Google Sheet" / "Open Sheet" buttons on the
// admin Tracking page. The actual work lives in ../sheets.js.

const express = require("express");
const router = express.Router();
const sheets = require("../sheets");

// GET /api/sheets/status — is the sheet connected, and where is it?
router.get("/status", requireAdmin, (req, res) => {
    const configured = sheets.isConfigured();
    res.json({ configured, sheetUrl: configured ? sheets.sheetUrl() : null });
});

// POST /api/sheets/sync — rebuild the whole sheet from the database
router.post("/sync", requireAdmin, async (req, res) => {
    if (!sheets.isConfigured()) {
        return res.status(400).json({ error: "Google Sheets isn't connected yet. Add the two Google settings on Render first." });
    }

    try {
        const result = await sheets.syncAllBookings();
        res.json(result);
    } catch (err) {
        console.error("POST /api/sheets/sync failed:", err.message);

        let message = `Couldn't update the sheet: ${err.message}`;

        if (err.status === 403) {
            message = "Google refused access. The usual causes: the sheet isn't shared with the robot account's email as an Editor, or the Google Sheets API isn't switched on in the Google Cloud project.";
        } else if (err.status === 404) {
            message = "Google can't find that sheet. Check that the Sheet ID on Render is correct.";
        }

        res.status(502).json({ error: message });
    }
});

module.exports = router;
