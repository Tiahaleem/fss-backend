// =========================
// ANALYTICS (admin)
// =========================
// Real numbers computed directly from the bookings table — nothing
// cached or estimated. "Revenue" only counts bookings still in
// 'confirmed' status, since a cancelled or refunded booking isn't
// money you actually kept.

const express = require("express");
const router = express.Router();
const pool = require("../db");
const { requireAdmin } = require("../middleware/requireAuth");

router.get("/", requireAdmin, async (req, res) => {
    try {
        const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);

        const summaryResult = await pool.query(
            `SELECT
                COUNT(*) AS total_bookings,
                COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_count,
                COALESCE(SUM(price_kobo) FILTER (WHERE status = 'confirmed'), 0) AS total_revenue_kobo,
                COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled_count,
                COUNT(*) FILTER (WHERE status = 'refunded') AS refunded_count,
                COALESCE(SUM(price_kobo) FILTER (WHERE status = 'refunded'), 0) AS refunded_kobo
             FROM bookings
             WHERE created_at >= now() - ($1 || ' days')::interval`,
            [days]
        );

        const dailyResult = await pool.query(
            `SELECT
                DATE(created_at) AS date,
                COUNT(*) AS bookings_count,
                COALESCE(SUM(price_kobo) FILTER (WHERE status = 'confirmed'), 0) AS revenue_kobo
             FROM bookings
             WHERE created_at >= now() - ($1 || ' days')::interval
             GROUP BY DATE(created_at)
             ORDER BY date`,
            [days]
        );

        const topRoutesResult = await pool.query(
            `SELECT
                r.from_city, r.to_city,
                COUNT(*) AS bookings_count,
                COALESCE(SUM(b.price_kobo), 0) AS revenue_kobo
             FROM bookings b
             JOIN passenger_bookings pb ON pb.booking_id = b.id
             JOIN trips t ON t.id = pb.trip_id
             JOIN routes r ON r.id = t.route_id
             WHERE b.status = 'confirmed'
               AND b.created_at >= now() - ($1 || ' days')::interval
             GROUP BY r.from_city, r.to_city
             ORDER BY bookings_count DESC
             LIMIT 5`,
            [days]
        );

        res.json({
            days,
            summary: {
                totalBookings: Number(summaryResult.rows[0].total_bookings),
                confirmedCount: Number(summaryResult.rows[0].confirmed_count),
                totalRevenueKobo: Number(summaryResult.rows[0].total_revenue_kobo),
                cancelledCount: Number(summaryResult.rows[0].cancelled_count),
                refundedCount: Number(summaryResult.rows[0].refunded_count),
                refundedKobo: Number(summaryResult.rows[0].refunded_kobo)
            },
            daily: dailyResult.rows.map(r => ({
                date: r.date,
                bookingsCount: Number(r.bookings_count),
                revenueKobo: Number(r.revenue_kobo)
            })),
            topRoutes: topRoutesResult.rows.map(r => ({
                route: `${r.from_city} → ${r.to_city}`,
                bookingsCount: Number(r.bookings_count),
                revenueKobo: Number(r.revenue_kobo)
            }))
        });
    } catch (err) {
        console.error("GET /api/analytics failed:", err.message);
        res.status(500).json({ error: "Couldn't load analytics." });
    }
});

module.exports = router;
