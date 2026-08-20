// =========================
// FSS TRANSPORT API — SERVER
// =========================

require("dotenv").config();

const express = require("express");
const cors = require("cors");

const routesRouter = require("./routes/routes");
const terminalsRouter = require("./routes/terminals");
const tripsRouter = require("./routes/trips");
const authRouter = require("./routes/auth");
const seatsRouter = require("./routes/seats");
const bookingsRouter = require("./routes/bookings");
const eventsRouter = require("./routes/events");

const app = express();

// Only these origins can call this API — anywhere else gets blocked.
// Includes your live GitHub Pages site AND localhost, so Live Server
// testing keeps working alongside the real deployed site.
const allowedOrigins = [
    "https://tiahaleem.github.io",
    "http://localhost:5500",
    "http://127.0.0.1:5500"
];

app.use(cors({
    origin: function (origin, callback) {
        // Requests with no Origin header (curl, server-to-server,
        // health checks) are allowed through — browsers always send
        // one, so this doesn't weaken protection against other websites.
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error("Not allowed by CORS"));
        }
    }
}));
app.use(express.json());

// Health check — useful for confirming the server is actually up
// once it's deployed, before worrying about anything else
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

app.use("/api/routes", routesRouter);
app.use("/api/terminals", terminalsRouter);
app.use("/api/trips", tripsRouter);
app.use("/api/trips/:tripId/seats", seatsRouter);
app.use("/api/auth", authRouter);
app.use("/api/bookings", bookingsRouter);
app.use("/api/events", eventsRouter);

const PORT = process.env.PORT || 4000;

// Catches errors thrown by middleware (like the CORS rejection above)
// and anything else that reaches here uncaught — returns clean JSON
// instead of Express's default HTML error page with a stack trace.
app.use((err, req, res, next) => {
    console.error(err.message);
    res.status(err.status || 500).json({ error: "Something went wrong." });
});

app.listen(PORT, () => {
    console.log(`FSS Transport API running on port ${PORT}`);
});