const { requireAdmin } = require("../middleware/requireAuth");
// =========================
// SITE SETTINGS API
// =========================
// A small, general-purpose key-value store for site-wide policies
// admin should be able to change without needing a code change or
// redeploy — starting with max luggage weight, but built to hold
// more of these over time.

const express = require("express");
const router = express.Router();
const pool = require("../db");

// GET /api/settings — public, returns every setting as a plain object
router.get("/", async (req, res) => {
    try {
        const result = await pool.query("SELECT key, value FROM site_settings");
        const settings = {};
        result.rows.forEach(row => { settings[row.key] = row.value; });
        res.json(settings);
    } catch (err) {
        console.error("GET /api/settings failed:", err);
        res.status(500).json({ error: "Couldn't load settings." });
    }
});

// PUT /api/settings/:key — admin updates one setting
router.put("/:key", requireAdmin, async (req, res) => {
    try {
        const { value } = req.body;

        if (value === undefined || value === null || value === "") {
            return res.status(400).json({ error: "value is required." });
        }

        const result = await pool.query(
            `UPDATE site_settings SET value = $1, updated_at = now() WHERE key = $2 RETURNING *`,
            [String(value), req.params.key]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "That setting doesn't exist." });
        }

        res.json({ key: result.rows[0].key, value: result.rows[0].value });
    } catch (err) {
        console.error("PUT /api/settings/:key failed:", err);
        res.status(500).json({ error: "Couldn't update that setting." });
    }
});

module.exports = router;
