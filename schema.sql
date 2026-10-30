-- Minimal schema for the CPUT Housing Portal API.
-- Matches the tables and columns queried by server.js and worker.js.
-- Roles and statuses are the values the README documents as enums.

CREATE TABLE IF NOT EXISTS campuses (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    location TEXT
);

CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student', 'staff')),
    full_name TEXT NOT NULL,
    student_number TEXT,
    campus_id INTEGER REFERENCES campuses (id),
    declared_registration BOOLEAN NOT NULL DEFAULT FALSE,
    declared_residence BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS residences (
    id SERIAL PRIMARY KEY,
    campus_id INTEGER NOT NULL REFERENCES campuses (id),
    name TEXT NOT NULL,
    address TEXT
);

CREATE TABLE IF NOT EXISTS rooms (
    id SERIAL PRIMARY KEY,
    residence_id INTEGER NOT NULL REFERENCES residences (id),
    room_number TEXT NOT NULL,
    floor INTEGER,
    status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'occupied'))
);

CREATE TABLE IF NOT EXISTS documents (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES users (id),
    file_name TEXT NOT NULL,
    file_size_bytes INTEGER,
    file_path TEXT,
    uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bookings (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES users (id),
    room_id INTEGER NOT NULL REFERENCES rooms (id),
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    checked_in_at TIMESTAMPTZ
);
