// =========================
// DATABASE CONNECTION
// =========================
// One shared connection pool for the whole app — every route file
// imports this instead of each opening its own connection.

const { Pool } = require("pg");

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

pool.on("error", (err) => {
    console.error("Unexpected database error:", err);
});

module.exports = pool;
