-- =====================================================================
-- FSS TRANSPORT — DATABASE SCHEMA (PostgreSQL)
-- =====================================================================
-- This replaces every localStorage-backed get___()/save___() function
-- in index.js with a real table. Each section below is labeled with
-- exactly which frontend function it replaces, so nothing gets lost
-- in the swap-over.
--
-- Design notes:
--   - UUIDs are used for public-facing IDs (routes, trips, bookings,
--     etc.) instead of auto-increment integers, so booking references
--     and trip IDs can't be guessed or enumerated by changing a number
--     in the URL.
--   - Every table has created_at / updated_at for basic auditing —
--     something localStorage never gave us.
--   - Money is stored in kobo (the smallest Naira unit, like cents)
--     as an integer, not a decimal — this avoids floating-point
--     rounding errors on prices. Divide by 100 to display Naira.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- for gen_random_uuid()


-- =====================================================================
-- USERS
-- Replaces: getUsers() / saveUsers() / getCurrentUser() / setCurrentUser()
--           getAdminUsers() / saveAdminUsers() / getCurrentAdmin()
-- =====================================================================
-- One table for both customers and staff, distinguished by `role`.
-- The two separate localStorage stores (fss_users / fss_admin_users)
-- were a pragmatic frontend simplification, not good database design —
-- a real system shouldn't need two near-identical account tables.

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(120)    NOT NULL,
    email           VARCHAR(255)    NOT NULL UNIQUE,
    password_hash   VARCHAR(255), -- bcrypt hash, NEVER plaintext. NULL for Google-only accounts (no password set).
    google_id       VARCHAR(255)    UNIQUE, -- links to a Google account, for "Sign in with Google"
    role            VARCHAR(20)     NOT NULL DEFAULT 'customer'
                        CHECK (role IN ('customer', 'admin')),
    email_verified  BOOLEAN         NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ     NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ     NOT NULL DEFAULT now()
);

CREATE INDEX idx_users_email ON users(email);


-- Short-lived codes for the email verification step (signup.html) and
-- password resets. Replaces the pendingSignup variable that only
-- existed in memory in auth.js — this makes it survive page reloads
-- and actually be checkable server-side.

CREATE TABLE verification_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
    email       VARCHAR(255) NOT NULL, -- kept even before the user row exists
    code        VARCHAR(6)   NOT NULL,
    purpose     VARCHAR(20)  NOT NULL DEFAULT 'signup'
                    CHECK (purpose IN ('signup', 'password_reset')),
    expires_at  TIMESTAMPTZ  NOT NULL,
    used_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_verification_codes_email ON verification_codes(email);


-- =====================================================================
-- ROUTES
-- Replaces: getRoutes() / saveRoutes()
-- =====================================================================
-- One row per city pair (Lagos → Abuja, Lagos → Port Harcourt, etc.).
-- Price and duration live here, not on individual trips — see the
-- "route contains many trips" explanation from earlier in the project.

CREATE TABLE routes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_city   VARCHAR(80)  NOT NULL,
    to_city     VARCHAR(80)  NOT NULL,
    distance_km INTEGER      NOT NULL,
    duration    VARCHAR(20)  NOT NULL, -- kept as text ("11h 00m") to match the UI directly
    price_kobo  BIGINT       NOT NULL,
    status      VARCHAR(10)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),

    UNIQUE (from_city, to_city)
);

CREATE INDEX idx_routes_from_to ON routes(from_city, to_city);


-- =====================================================================
-- TERMINALS
-- Replaces: getTerminals() / saveTerminals()
-- =====================================================================

CREATE TABLE terminals (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city        VARCHAR(80)  NOT NULL,
    name        VARCHAR(120) NOT NULL,
    address     VARCHAR(255) NOT NULL,
    phone       VARCHAR(30)  NOT NULL,
    hours       VARCHAR(60)  NOT NULL,
    status      VARCHAR(10)  NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_terminals_city ON terminals(city);


-- =====================================================================
-- TRIPS
-- Replaces: getTrips() / saveTrips()
-- =====================================================================
-- Each row is one scheduled departure on a route. Linked to routes by
-- route_id (a real foreign key) instead of duplicating from/to text
-- on every trip, the way the localStorage version had to.

CREATE TABLE trips (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    route_id        UUID NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
    departure_time  TIME NOT NULL, -- e.g. 06:00 — the daily recurring time
    vehicle         VARCHAR(80) NOT NULL,
    total_seats     SMALLINT    NOT NULL,
    status          VARCHAR(10) NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'inactive')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_trips_route_id ON trips(route_id);


-- =====================================================================
-- BOOKINGS (shared parent table)
-- Replaces: getBookings() / saveBookings()
-- =====================================================================
-- Created before seat_holds/passenger_bookings/parcel_bookings below,
-- since those reference it.

CREATE TABLE bookings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reference   VARCHAR(20) NOT NULL UNIQUE, -- e.g. "FSS-7Q2XM4", "PCL-9K1RT2"
    type        VARCHAR(10) NOT NULL
                    CHECK (type IN ('parcel', 'passenger')),
    owner_id    UUID REFERENCES users(id), -- NULL for a guest booking (not signed in)
    price_kobo  BIGINT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                    CHECK (status IN ('confirmed', 'cancelled', 'refunded')),
    payment_reference VARCHAR(100), -- the real Paystack transaction reference — needed to actually issue a refund against this specific payment
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bookings_owner_id ON bookings(owner_id);
CREATE INDEX idx_bookings_reference ON bookings(reference);


-- =====================================================================
-- SEAT HOLDS / BOOKED SEATS
-- Replaces: getAllSeatHolds() / saveAllSeatHolds() /
--           getActiveSeatHoldsForTrip() / saveSeatHoldsForTrip()
-- =====================================================================
-- This is the one that actually solves the double-booking problem for
-- real, since every customer's browser now talks to the SAME table
-- instead of their own separate localStorage. A UNIQUE constraint on
-- (trip_id, seat_number) is what makes it airtight — the database
-- itself refuses to let two people hold/book the same seat on the
-- same trip, even if two requests arrive at the exact same millisecond.

CREATE TABLE seat_holds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trip_id         UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
    travel_date     DATE NOT NULL, -- which calendar day this hold/booking is for — the SAME trip has its own independent seat map per day
    seat_number     VARCHAR(4) NOT NULL,
    status          VARCHAR(10) NOT NULL
                        CHECK (status IN ('held', 'booked')),
    held_by_session VARCHAR(50), -- NULL once status = 'booked'
    booking_id      UUID REFERENCES bookings(id), -- set once status = 'booked'
    expires_at      TIMESTAMPTZ, -- NULL once status = 'booked' (no expiry on a real booking)
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (trip_id, travel_date, seat_number)
);

CREATE INDEX idx_seat_holds_trip_id ON seat_holds(trip_id);
CREATE INDEX idx_seat_holds_trip_date ON seat_holds(trip_id, travel_date);

-- Note: a scheduled job (cron) should periodically DELETE rows where
-- status = 'held' AND expires_at < now() — same "release abandoned
-- holds" behavior getActiveSeatHoldsForTrip() did on every read, just
-- run server-side on a timer instead of client-side on every page load.


-- Passenger-specific details — one row per booking, covering the
-- whole group (1 or more seats). Which seats belong to this booking
-- is found via seat_holds WHERE booking_id = this booking's id —
-- that table already supports many seats pointing at one booking,
-- so there's no need to duplicate a seat number here.
CREATE TABLE passenger_bookings (
    booking_id      UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
    trip_id         UUID NOT NULL REFERENCES trips(id),
    terminal_id     UUID NOT NULL REFERENCES terminals(id), -- pickup center
    passenger_name  VARCHAR(120) NOT NULL,
    passenger_email VARCHAR(255) NOT NULL,
    passenger_phone VARCHAR(30)  NOT NULL,
    travel_date     DATE         NOT NULL,
    reminder_sent_at TIMESTAMPTZ -- NULL until the departure-reminder email goes out; stops it sending twice
);


-- Parcel-specific details — one row per parcel booking.
CREATE TABLE parcel_bookings (
    booking_id      UUID PRIMARY KEY REFERENCES bookings(id) ON DELETE CASCADE,
    from_city       VARCHAR(80)  NOT NULL,
    to_city         VARCHAR(80)  NOT NULL,
    sender_name     VARCHAR(120) NOT NULL,
    sender_phone    VARCHAR(30)  NOT NULL,
    sender_email    VARCHAR(255) NOT NULL,
    receiver_name   VARCHAR(120) NOT NULL,
    receiver_phone  VARCHAR(30)  NOT NULL,
    description     TEXT         NOT NULL,
    weight_kg       NUMERIC(6,2) NOT NULL,
    declared_value_kobo BIGINT   NOT NULL
);


-- =====================================================================
-- TRACKING EVENTS
-- Replaces: getTrackingEvents() / saveTrackingEvents()
-- =====================================================================
-- Linked to bookings by booking_id (a real foreign key) instead of
-- matching on the reference string, which is safer and faster.

CREATE TABLE tracking_events (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    booking_id  UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    sort_order  SMALLINT    NOT NULL,
    title       VARCHAR(120) NOT NULL,
    event_time  VARCHAR(20)  NOT NULL, -- kept as display text ("18:15 (ETA)") to match the UI
    status      VARCHAR(10)  NOT NULL
                    CHECK (status IN ('completed', 'active', 'pending')),
    icon        VARCHAR(20)  NOT NULL DEFAULT 'location'
                    CHECK (icon IN ('boarding', 'departed', 'checkpoint', 'location', 'arrival', 'delivered')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_tracking_events_booking_id ON tracking_events(booking_id);
