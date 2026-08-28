// =========================
// REVIEWS
// =========================
// A review can only be left for a REAL, completed trip — checked
// server-side, not just hidden in the UI:
//   - the booking must actually belong to the person submitting it
//   - it must be a passenger booking (parcels don't get "reviewed" the same way)
//   - it must still be 'confirmed' (not cancelled/refunded)
//   - the travel date must genuinely be in the past
//   - only one review per booking, ever

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAuth } = require("../middleware/requireAuth");

// =========================
// POST /api/reviews
// =========================
router.post("/", requireAuth, async (req, res) => {
    try {
        const { bookingId, rating, comment } = req.body;

        const ratingNum = Number(rating);
        if (!bookingId || !Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
            return res.status(400).json({ error: "A booking and a rating from 1 to 5 are required." });
        }

        const bookingResult = await pool.query(
            `SELECT b.id, b.owner_id, b.type, b.status, pb.travel_date
             FROM bookings b
             LEFT JOIN passenger_bookings pb ON pb.booking_id = b.id
             WHERE b.id = $1`,
            [bookingId]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: "Booking not found." });
        }

        const booking = bookingResult.rows[0];

        if (booking.owner_id !== req.user.id) {
            return res.status(403).json({ error: "You can only review your own bookings." });
        }

        if (booking.type !== "passenger") {
            return res.status(400).json({ error: "Only trip bookings can be reviewed." });
        }

        if (booking.status !== "confirmed") {
            return res.status(400).json({ error: `This booking is ${booking.status} and can't be reviewed.` });
        }

        const travelDate = new Date(booking.travel_date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (travelDate >= today) {
            return res.status(400).json({ error: "You can only review a trip after it's actually happened." });
        }

        const existing = await pool.query("SELECT id FROM reviews WHERE booking_id = $1", [bookingId]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: "You've already reviewed this trip." });
        }

        const insertResult = await pool.query(
            `INSERT INTO reviews (booking_id, user_id, rating, comment)
             VALUES ($1, $2, $3, $4)
             RETURNING id, rating, comment, created_at`,
            [bookingId, req.user.id, ratingNum, (comment || "").trim() || null]
        );

        res.status(201).json(insertResult.rows[0]);
    } catch (err) {
        if (err.code === "23505") {
            return res.status(409).json({ error: "You've already reviewed this trip." });
        }
        console.error("POST /api/reviews failed:", err.message);
        res.status(500).json({ error: "Couldn't submit that review." });
    }
});

// =========================
// GET /api/reviews — public, for testimonials on the site
// =========================
router.get("/", async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);

        const result = await pool.query(
            `SELECT rev.rating, rev.comment, rev.created_at,
                    pb.passenger_name, r.from_city, r.to_city
             FROM reviews rev
             JOIN bookings b ON b.id = rev.booking_id
             JOIN passenger_bookings pb ON pb.booking_id = b.id
             JOIN trips t ON t.id = pb.trip_id
             JOIN routes r ON r.id = t.route_id
             ORDER BY rev.created_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json(result.rows.map(r => ({
            // First name only, shown publicly — not the full name
            name: r.passenger_name.trim().split(" ")[0],
            rating: r.rating,
            comment: r.comment,
            route: `${r.from_city} → ${r.to_city}`,
            createdAt: r.created_at
        })));
    } catch (err) {
        console.error("GET /api/reviews failed:", err.message);
        res.status(500).json({ error: "Couldn't load reviews." });
    }
});

// =========================
// GET /api/reviews/summary — public, overall average + count
// =========================
router.get("/summary", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT COUNT(*) AS review_count, COALESCE(AVG(rating), 0) AS average_rating FROM reviews"
        );

        res.json({
            reviewCount: Number(result.rows[0].review_count),
            averageRating: Math.round(Number(result.rows[0].average_rating) * 10) / 10
        });
    } catch (err) {
        console.error("GET /api/reviews/summary failed:", err.message);
        res.status(500).json({ error: "Couldn't load review summary." });
    }
});

module.exports = router;
