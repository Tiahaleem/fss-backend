// =========================
// GOOGLE SHEETS MIRROR
// =========================
// Keeps a Google Sheet in step with the bookings table, so the
// transaction history can be sorted, totalled and shared without
// anyone touching the database.
//
// The database stays the real record. The sheet is a COPY:
//   - a new booking adds a row
//   - a cancel/refund updates that row's Status
//   - "sync" (admin button) rebuilds the whole sheet from the database
//
// The golden rule here: nothing in this file may ever break a real
// booking. appendBookingRow / updateBookingStatus never throw — if
// Google is down or misconfigured they log the problem (which also
// triggers the error-alert email) and carry on.
//
// Setup needs two environment variables on Render:
//   GOOGLE_SHEETS_ID               the long id in the sheet's URL
//   GOOGLE_SERVICE_ACCOUNT_JSON    the whole contents of the robot
//                                  account's key file (a secret!)
// Without them, everything here quietly does nothing.

const { JWT } = require("google-auth-library");
const pool = require("./db");

const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

const HEADER = [
    "Booked On", "Reference", "Type", "Customer", "Phone", "Recipient",
    "Route", "Trip Date", "Departure", "Seats", "Status", "Amount (₦)", "Payment Reference"
];
const LAST_COLUMN = "M";
const REFERENCE_COLUMN = "B";
const STATUS_COLUMN = "K";
const REFERENCE_INDEX = 1;
const SEATS_INDEX = 9;

function tabName() {
    return process.env.GOOGLE_SHEETS_TAB || "Transactions";
}

function isConfigured() {
    return Boolean(process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
}

function sheetUrl() {
    return `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEETS_ID}`;
}

// ---------- talking to Google ----------

let cachedClient = null;
let cachedKeyText = null;
let tabReady = false;

function getClient() {
    const keyText = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (cachedClient && cachedKeyText === keyText) return cachedClient;

    let credentials;
    try {
        credentials = JSON.parse(keyText);
    } catch (err) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON isn't valid JSON. Paste the whole contents of the key file.");
    }

    if (!credentials.client_email || !credentials.private_key) {
        throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key. Make sure it's the full key file.");
    }

    cachedClient = new JWT({
        email: credentials.client_email,
        // Some places double-escape the line breaks in the key — undo that.
        key: credentials.private_key.replace(/\\n/g, "\n"),
        scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });
    cachedKeyText = keyText;
    return cachedClient;
}

// Turns Google's error into a plain Error carrying the HTTP status,
// so callers (and the admin button) can give a useful explanation.
function describeGoogleError(err) {
    const status = err.response?.status || (typeof err.status === "number" ? err.status : undefined);
    const message = err.response?.data?.error?.message || err.message || "Unknown Google error";
    const wrapped = new Error(message);
    wrapped.status = status;
    return wrapped;
}

async function callApi({ method = "GET", path, params, data }) {
    const client = getClient();
    try {
        const response = await client.request({
            url: `${SHEETS_API}/${process.env.GOOGLE_SHEETS_ID}${path}`,
            method,
            params,
            data
        });
        return response.data;
    } catch (err) {
        throw describeGoogleError(err);
    }
}

// A1 notation for this tab, e.g. 'Transactions'!A:M (quoted so tab
// names with spaces still work).
function a1(range) {
    return `'${tabName().replace(/'/g, "''")}'!${range}`;
}

function valuesPath(range, suffix = "") {
    return `/values/${encodeURIComponent(a1(range))}${suffix}`;
}

// Makes sure the tab exists and has its header row — creating either
// if needed, so setup is just "make a blank sheet and share it".
async function ensureTab() {
    if (tabReady) return;

    const meta = await callApi({ path: "", params: { fields: "sheets.properties(sheetId,title)" } });
    let tab = (meta.sheets || []).find(s => s.properties.title === tabName());

    if (!tab) {
        const created = await callApi({
            method: "POST",
            path: ":batchUpdate",
            data: { requests: [{ addSheet: { properties: { title: tabName(), gridProperties: { frozenRowCount: 1 } } } }] }
        });
        tab = { properties: created.replies[0].addSheet.properties };
    }

    const firstRow = await callApi({ path: valuesPath(`A1:${LAST_COLUMN}1`) });
    const hasHeader = firstRow.values && firstRow.values[0] && firstRow.values[0].length > 0;

    if (!hasHeader) {
        await callApi({
            method: "PUT",
            path: valuesPath(`A1:${LAST_COLUMN}1`),
            params: { valueInputOption: "RAW" },
            data: { values: [HEADER] }
        });

        // Bold header — purely cosmetic, so a failure here is ignored.
        try {
            await callApi({
                method: "POST",
                path: ":batchUpdate",
                data: { requests: [{ repeatCell: {
                    range: { sheetId: tab.properties.sheetId, startRowIndex: 0, endRowIndex: 1 },
                    cell: { userEnteredFormat: { textFormat: { bold: true } } },
                    fields: "userEnteredFormat.textFormat.bold"
                } }] }
            });
        } catch (_) { /* cosmetic only */ }
    }

    tabReady = true;
}

async function findRowNumber(reference) {
    const column = await callApi({ path: valuesPath(`${REFERENCE_COLUMN}:${REFERENCE_COLUMN}`) });
    const values = column.values || [];

    for (let i = 0; i < values.length; i++) {
        if (values[i][0] === reference) return i + 1; // sheet rows start at 1
    }
    return null;
}

// The code remembers "the tab exists" so it doesn't re-check on every
// booking. But if someone deletes the tab in Google Sheets, that memory
// goes stale. So: if something fails while relying on the remembered
// state, forget it and try once more — which re-creates the tab if
// needed. (If the failure happened on a fresh check, retrying won't
// help, so it's passed straight up.)
async function withTabRetry(operation) {
    try {
        return await operation();
    } catch (err) {
        if (!tabReady) throw err;
        tabReady = false;
        return await operation();
    }
}

// ---------- reading the database ----------

async function fetchBookingRows(reference = null) {
    const params = [];
    let where = "";

    if (reference) {
        params.push(reference);
        where = "WHERE b.reference = $1";
    }

    const result = await pool.query(
        `SELECT
            b.reference, b.type, b.status, b.price_kobo, b.created_at, b.payment_reference,
            pb.passenger_name, pb.passenger_phone,
            to_char(pb.travel_date, 'YYYY-MM-DD') AS travel_date,
            t.departure_time,
            (SELECT string_agg(seat_number, ', ' ORDER BY seat_number) FROM seat_holds WHERE booking_id = b.id) AS seat_numbers,
            pab.sender_name, pab.sender_phone, pab.receiver_name, pab.receiver_phone,
            COALESCE(pab.from_city, r.from_city) AS from_city,
            COALESCE(pab.to_city, r.to_city) AS to_city
         FROM bookings b
         LEFT JOIN passenger_bookings pb ON pb.booking_id = b.id
         LEFT JOIN parcel_bookings pab ON pab.booking_id = b.id
         LEFT JOIN trips t ON t.id = pb.trip_id
         LEFT JOIN routes r ON r.id = t.route_id
         ${where}
         ORDER BY b.created_at ASC`,
        params
    );

    return result.rows;
}

const bookedOnFormatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Africa/Lagos",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit"
});

function capitalise(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

function buildRow(b) {
    const isParcel = b.type === "parcel";

    return [
        bookedOnFormatter.format(new Date(b.created_at)),            // Booked On (Lagos time)
        b.reference,                                                  // Reference
        isParcel ? "Parcel" : "Passenger",                            // Type
        (isParcel ? b.sender_name : b.passenger_name) || "",          // Customer
        (isParcel ? b.sender_phone : b.passenger_phone) || "",        // Phone
        isParcel ? `${b.receiver_name || ""} (${b.receiver_phone || ""})` : "", // Recipient
        b.from_city && b.to_city ? `${b.from_city} → ${b.to_city}` : "",       // Route
        b.travel_date || "",                                          // Trip Date
        b.departure_time ? b.departure_time.slice(0, 5) : "",         // Departure
        b.seat_numbers || "",                                         // Seats
        capitalise(b.status),                                         // Status
        Number(b.price_kobo) / 100,                                   // Amount (₦)
        b.payment_reference || ""                                     // Payment Reference
    ];
}

// ---------- the three things the rest of the app calls ----------
// Every write below uses valueInputOption RAW on purpose: it stores
// exactly what we send as plain values. (The alternative would let
// Sheets interpret a customer name like "=HYPERLINK(...)" as a
// formula, or turn "+234…" into a number.)

// New booking → new row. Safe to call twice: it won't add a duplicate.
async function appendBookingRow(reference) {
    if (!isConfigured()) return { skipped: true };

    try {
        return await withTabRetry(async () => {
            const rows = await fetchBookingRows(reference);
            if (rows.length === 0) return { skipped: true };

            await ensureTab();

            if (await findRowNumber(reference)) return { skipped: true, reason: "already in the sheet" };

            await callApi({
                method: "POST",
                path: valuesPath(`A:${LAST_COLUMN}`, ":append"),
                params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
                data: { values: [buildRow(rows[0])] }
            });

            return { appended: true };
        });
    } catch (err) {
        tabReady = false;
        console.error("Google Sheets: couldn't add a booking row:", err);
        return { error: err.message };
    }
}

// Cancel/refund → update just that row's Status cell, read fresh from
// the database. (Only the Status cell, on purpose: cancelling releases
// the seats, so rewriting the whole row would blank out the seat
// numbers the sheet recorded when the booking was made.)
async function updateBookingStatus(reference) {
    if (!isConfigured()) return { skipped: true };

    try {
        return await withTabRetry(async () => {
            const rows = await fetchBookingRows(reference);
            if (rows.length === 0) return { skipped: true };

            await ensureTab();

            const rowNumber = await findRowNumber(reference);

            if (!rowNumber) {
                // The sheet never got this booking (e.g. it was made before the
                // sheet was connected) — add it now rather than lose it.
                await callApi({
                    method: "POST",
                    path: valuesPath(`A:${LAST_COLUMN}`, ":append"),
                    params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
                    data: { values: [buildRow(rows[0])] }
                });
                return { appended: true };
            }

            await callApi({
                method: "PUT",
                path: valuesPath(`${STATUS_COLUMN}${rowNumber}`),
                params: { valueInputOption: "RAW" },
                data: { values: [[capitalise(rows[0].status)]] }
            });

            return { updated: true };
        });
    } catch (err) {
        tabReady = false;
        console.error("Google Sheets: couldn't update a booking's status:", err);
        return { error: err.message };
    }
}

// Rebuilds the whole sheet from the database. Unlike the two above,
// this DOES throw — the admin pressed a button and deserves to hear
// exactly what went wrong.
async function syncAllBookings() {
    if (!isConfigured()) {
        const err = new Error("Google Sheets isn't connected yet.");
        err.status = 400;
        throw err;
    }

    try {
        return await withTabRetry(async () => {
        await ensureTab();

        // Remember the seat numbers already in the sheet: a booking that
        // was cancelled since has had its seats released in the database,
        // and we'd rather keep the original record than blank it.
        const existing = await callApi({ path: valuesPath(`A2:${LAST_COLUMN}`) });
        const seatsByReference = {};
        (existing.values || []).forEach(row => {
            if (row[REFERENCE_INDEX] && row[SEATS_INDEX]) seatsByReference[row[REFERENCE_INDEX]] = row[SEATS_INDEX];
        });

        const bookings = await fetchBookingRows();
        const rows = bookings.map(b => {
            const row = buildRow(b);
            if (!row[SEATS_INDEX] && seatsByReference[row[REFERENCE_INDEX]]) {
                row[SEATS_INDEX] = seatsByReference[row[REFERENCE_INDEX]];
            }
            return row;
        });

        await callApi({ method: "POST", path: valuesPath(`A:${LAST_COLUMN}`, ":clear"), data: {} });

        await callApi({
            method: "PUT",
            path: valuesPath(`A1:${LAST_COLUMN}1`),
            params: { valueInputOption: "RAW" },
            data: { values: [HEADER] }
        });

        // Appended in chunks — append grows the sheet as needed, where
        // a plain write would fail past the sheet's current size.
        const CHUNK = 500;
        for (let i = 0; i < rows.length; i += CHUNK) {
            await callApi({
                method: "POST",
                path: valuesPath(`A:${LAST_COLUMN}`, ":append"),
                params: { valueInputOption: "RAW", insertDataOption: "INSERT_ROWS" },
                data: { values: rows.slice(i, i + CHUNK) }
            });
        }

        return { rowsWritten: rows.length };
        });
    } catch (err) {
        tabReady = false;
        throw err;
    }
}

module.exports = {
    isConfigured,
    sheetUrl,
    appendBookingRow,
    updateBookingStatus,
    syncAllBookings
};
