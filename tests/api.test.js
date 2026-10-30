'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { describe, it, before, after, beforeEach } = require('node:test');
const jwt = require('jsonwebtoken');
const { Client } = require('pg');

require('dotenv').config();

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-cput-housing-portal';
process.env.DB_USER = process.env.DB_USER || 'postgres';
process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_NAME = process.env.DB_NAME || 'cput_housing_test';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
process.env.DB_PORT = process.env.DB_PORT || '5432';

const PASSWORD = '12345678';
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');
const PII = {
    email: 'pii.student@mycput.ac.za',
    full_name: 'PII Secret Name',
    student_number: 'SN-998877'
};

let request;
let app;
let pool;
let releaseExpiredBookings;
let workerPool;

function adminConfig() {
    return {
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: 'postgres',
        password: process.env.DB_PASSWORD,
        port: Number(process.env.DB_PORT)
    };
}

async function ensureDatabase() {
    const dbName = process.env.DB_NAME;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dbName)) {
        throw new Error(`Refusing unsafe DB_NAME: ${dbName}`);
    }

    const admin = new Client(adminConfig());
    try {
        await admin.connect();
    } catch (error) {
        throw new Error(
            `Could not connect to PostgreSQL at ${process.env.DB_HOST}:${process.env.DB_PORT} as ${process.env.DB_USER}: ${error.message}`
        );
    }

    try {
        const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
        if (exists.rowCount === 0) {
            if (!dbName.endsWith('_test')) {
                throw new Error(
                    `Database ${dbName} does not exist. Refusing to create a database whose name does not end with _test.`
                );
            }
            await admin.query(`CREATE DATABASE "${dbName}"`);
        }
    } finally {
        await admin.end();
    }
}

function assertSafeReset() {
    const name = process.env.DB_NAME;
    if (process.env.CI === 'true' || name.endsWith('_test')) return;
    throw new Error(
        `Refusing to reset database "${name}". Use a DB_NAME ending in _test (default cput_housing_test), or run in CI.`
    );
}

async function resetSchema() {
    assertSafeReset();
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await pool.query(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

async function truncateAll() {
    await pool.query(`
        TRUNCATE TABLE bookings, documents, rooms, residences, users, campuses
        RESTART IDENTITY CASCADE
    `);
}

async function registerStudent({
    email = 'student@mycput.ac.za',
    password = PASSWORD,
    full_name = 'John Doe',
    student_number = '12345678'
} = {}) {
    return request(app).post('/api/auth/register').send({
        email,
        password,
        full_name,
        student_number
    });
}

async function seedRoom({ roomNumber = '101', status = 'available' } = {}) {
    const campus = await pool.query(
        `INSERT INTO campuses (name, location) VALUES ('Bellville Campus', 'Bellville') RETURNING id`
    );
    const residence = await pool.query(
        `INSERT INTO residences (campus_id, name, address)
         VALUES ($1, 'Bellville Residence A', '789 Durban Rd, Bellville')
         RETURNING id`,
        [campus.rows[0].id]
    );
    const room = await pool.query(
        `INSERT INTO rooms (residence_id, room_number, floor, status)
         VALUES ($1, $2, 1, $3)
         RETURNING id`,
        [residence.rows[0].id, roomNumber, status]
    );
    return {
        campusId: campus.rows[0].id,
        residenceId: residence.rows[0].id,
        roomId: room.rows[0].id
    };
}

async function addRoom(residenceId, roomNumber) {
    const room = await pool.query(
        `INSERT INTO rooms (residence_id, room_number, floor, status)
         VALUES ($1, $2, 1, 'available')
         RETURNING id`,
        [residenceId, roomNumber]
    );
    return room.rows[0].id;
}

async function registerAndLoginStaff(overrides = {}) {
    const created = await registerStudent({
        email: 'staff.user@mycput.ac.za',
        full_name: 'Help Desk Staff',
        student_number: 'STAFF001',
        ...overrides
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    await pool.query(`UPDATE users SET role = 'staff' WHERE id = $1`, [created.body.user.id]);
    const login = await request(app)
        .post('/api/auth/login')
        .send({ email: created.body.user.email, password: PASSWORD });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.user.role, 'staff');
    return login.body;
}

function expiredToken(user) {
    return jwt.sign(
        {
            id: user.id,
            email: user.email,
            role: 'student',
            exp: Math.floor(Date.now() / 1000) - 60
        },
        process.env.JWT_SECRET,
        { algorithm: 'HS256' }
    );
}

function unsignedToken(user, alg) {
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        id: user.id,
        email: user.email,
        role: 'student',
        exp: Math.floor(Date.now() / 1000) + 3600
    })).toString('base64url');
    return `${header}.${body}.`;
}

function assertNoLeakedPii(res) {
    const raw = `${res.text || ''}`;
    assert.equal(raw.includes(PII.email), false, raw);
    assert.equal(raw.includes(PII.full_name), false, raw);
    assert.equal(raw.includes(PII.student_number), false, raw);
    assert.equal(res.body.users, undefined);
    assert.equal(res.body.success, undefined);
}

async function seedPiiStudent() {
    const created = await registerStudent(PII);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return created.body;
}

describe('CPUT Housing Portal API', { concurrency: 1 }, () => {
    before(async () => {
        await ensureDatabase();
        request = require('supertest');
        app = require('../server');
        pool = app.pool;
        const worker = require('../worker');
        releaseExpiredBookings = worker.releaseExpiredBookings;
        workerPool = worker.pool;
        await resetSchema();
    });

    after(async () => {
        if (pool) await pool.end();
        if (workerPool && workerPool !== pool) await workerPool.end();
    });

    beforeEach(async () => {
        await truncateAll();
    });

    describe('POST /api/auth/register', () => {
        it('registers a student and returns an HS256 token', async () => {
            const res = await registerStudent({
                email: 'Student.Happy@MyCPUT.ac.za',
                full_name: '  John Doe  ',
                student_number: ' 12345678 '
            });

            assert.equal(res.status, 201);
            assert.equal(res.body.message, 'Registered successfully!');
            assert.equal(res.body.user.email, 'student.happy@mycput.ac.za');
            assert.equal(res.body.user.full_name, 'John Doe');
            assert.equal(res.body.user.student_number, '12345678');
            assert.equal(res.body.user.password, undefined);
            assert.equal(res.body.user.password_hash, undefined);

            const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
            assert.equal(decoded.role, 'student');
            assert.equal(decoded.email, 'student.happy@mycput.ac.za');
            assert.equal(decoded.id, res.body.user.id);

            const row = await pool.query('SELECT email, role FROM users WHERE id = $1', [res.body.user.id]);
            assert.equal(row.rows[0].email, 'student.happy@mycput.ac.za');
            assert.equal(row.rows[0].role, 'student');
        });

        it('rejects an email outside @mycput.ac.za', async () => {
            const res = await registerStudent({ email: 'student@gmail.com' });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'Only @mycput.ac.za emails allowed.');
        });

        it('rejects a password shorter than 8 characters', async () => {
            const res = await registerStudent({ password: 'short7!' });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'Password must be at least 8 characters.');
        });

        it('rejects a password longer than 72 bytes', async () => {
            const res = await registerStudent({ password: 'x'.repeat(73) });
            assert.equal(res.status, 400);
            assert.equal(res.body.error, 'Password must be at most 72 bytes.');
        });

        it('rejects missing required fields', async () => {
            const missingName = await request(app).post('/api/auth/register').send({
                email: 'missing.name@mycput.ac.za',
                password: PASSWORD,
                student_number: '12345678'
            });
            assert.equal(missingName.status, 400);
            assert.equal(missingName.body.error, 'Missing required fields.');

            const missingNumber = await request(app).post('/api/auth/register').send({
                email: 'missing.number@mycput.ac.za',
                password: PASSWORD,
                full_name: 'John Doe'
            });
            assert.equal(missingNumber.status, 400);
            assert.equal(missingNumber.body.error, 'Missing required fields.');

            const missingPassword = await request(app).post('/api/auth/register').send({
                email: 'missing.password@mycput.ac.za',
                full_name: 'John Doe',
                student_number: '12345678'
            });
            assert.equal(missingPassword.status, 400);
            assert.equal(missingPassword.body.error, 'Missing required fields.');
        });

        it('rejects a duplicate email regardless of case', async () => {
            const first = await registerStudent({ email: 'dup.user@mycput.ac.za' });
            assert.equal(first.status, 201, JSON.stringify(first.body));

            const second = await registerStudent({
                email: 'DUP.USER@mycput.ac.za',
                student_number: '87654321'
            });
            assert.equal(second.status, 409);
            assert.equal(second.body.error, 'Email already registered.');
        });
    });

    describe('POST /api/auth/login', () => {
        it('logs in with the correct password and returns an HS256 token', async () => {
            const registered = await registerStudent({ email: 'login.ok@mycput.ac.za' });
            assert.equal(registered.status, 201, JSON.stringify(registered.body));

            const res = await request(app).post('/api/auth/login').send({
                email: 'login.ok@mycput.ac.za',
                password: PASSWORD
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.message, 'Login successful!');
            assert.equal(res.body.user.email, 'login.ok@mycput.ac.za');
            assert.equal(res.body.user.role, 'student');
            assert.equal(res.body.user.password_hash, undefined);
            const decoded = jwt.verify(res.body.token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
            assert.equal(decoded.email, 'login.ok@mycput.ac.za');
        });

        it('accepts the same account when the email casing differs', async () => {
            const registered = await registerStudent({ email: 'login.case@mycput.ac.za' });
            assert.equal(registered.status, 201, JSON.stringify(registered.body));

            const res = await request(app).post('/api/auth/login').send({
                email: '  LOGIN.CASE@MYCPUT.AC.ZA  ',
                password: PASSWORD
            });

            assert.equal(res.status, 200);
            assert.equal(res.body.user.email, 'login.case@mycput.ac.za');
        });

        it('rejects a wrong password', async () => {
            const registered = await registerStudent({ email: 'login.bad@mycput.ac.za' });
            assert.equal(registered.status, 201, JSON.stringify(registered.body));

            const res = await request(app).post('/api/auth/login').send({
                email: 'login.bad@mycput.ac.za',
                password: 'not-the-password'
            });

            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Invalid email or password.');
            assert.equal(res.body.token, undefined);
        });

        it('rejects an unknown email with the same error', async () => {
            const res = await request(app).post('/api/auth/login').send({
                email: 'nobody@mycput.ac.za',
                password: PASSWORD
            });

            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Invalid email or password.');
            assert.equal(res.body.token, undefined);
        });

        it('rejects a login missing email or password', async () => {
            const missingPassword = await request(app).post('/api/auth/login').send({
                email: 'login.ok@mycput.ac.za'
            });
            assert.equal(missingPassword.status, 400);
            assert.equal(missingPassword.body.error, 'Email and password are required.');

            const missingEmail = await request(app).post('/api/auth/login').send({
                password: PASSWORD
            });
            assert.equal(missingEmail.status, 400);
            assert.equal(missingEmail.body.error, 'Email and password are required.');
        });
    });

    describe('POST /api/rooms/reserve', () => {
        it('reserves an available room for a student', async () => {
            const student = await registerStudent({ email: 'reserve.ok@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();

            const res = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ room_id: roomId });

            assert.equal(res.status, 201);
            assert.equal(res.body.success, true);
            assert.equal(res.body.booking.status, 'pending');
            assert.match(res.body.booking.token, /^CPUT-[0-9a-f]{32}$/);
            assert.equal(res.body.expires_in, '72 hours');

            const booking = await pool.query('SELECT status, student_id FROM bookings WHERE id = $1', [res.body.booking.id]);
            assert.equal(booking.rows[0].status, 'pending');
            assert.equal(booking.rows[0].student_id, student.body.user.id);
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'reserved');
        });

        it('rejects a second active booking for the same student', async () => {
            const student = await registerStudent({ email: 'reserve.twice@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { residenceId, roomId } = await seedRoom({ roomNumber: '101' });
            const secondRoomId = await addRoom(residenceId, '102');

            const first = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ room_id: roomId });
            assert.equal(first.status, 201, JSON.stringify(first.body));

            const second = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ room_id: secondRoomId });

            assert.equal(second.status, 400);
            assert.equal(second.body.error, 'You already have an active booking.');

            const bookings = await pool.query('SELECT COUNT(*)::int AS count FROM bookings WHERE student_id = $1', [student.body.user.id]);
            assert.equal(bookings.rows[0].count, 1);
            const otherRoom = await pool.query('SELECT status FROM rooms WHERE id = $1', [secondRoomId]);
            assert.equal(otherRoom.rows[0].status, 'available');
        });

        it('rejects a staff token on the student reserve route', async () => {
            const staff = await registerAndLoginStaff({ email: 'staff.reserve@mycput.ac.za' });
            const { roomId } = await seedRoom();

            const res = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${staff.token}`)
                .send({ room_id: roomId });

            assert.equal(res.status, 403);
            assert.equal(res.body.error, 'Access denied. Student privileges required.');
            const bookings = await pool.query('SELECT COUNT(*)::int AS count FROM bookings');
            assert.equal(bookings.rows[0].count, 0);
        });
    });

    describe('POST /api/staff/verify', () => {
        it('checks a pending booking in and marks the room occupied', async () => {
            const student = await registerStudent({
                email: 'verify.student@mycput.ac.za',
                full_name: 'Verify Student',
                student_number: '22334455'
            });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom({ roomNumber: '101' });

            const reserved = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ room_id: roomId });
            assert.equal(reserved.status, 201, JSON.stringify(reserved.body));

            const staff = await registerAndLoginStaff({ email: 'verify.staff@mycput.ac.za' });
            const res = await request(app)
                .post('/api/staff/verify')
                .set('Authorization', `Bearer ${staff.token}`)
                .send({ token: reserved.body.booking.token });

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.equal(res.body.message, 'Check-in successful! Access granted.');
            assert.equal(res.body.student.name, 'Verify Student');
            assert.equal(res.body.student.student_number, '22334455');
            assert.equal(res.body.student.email, 'verify.student@mycput.ac.za');
            assert.equal(res.body.room.number, '101');
            assert.equal(res.body.room.residence, 'Bellville Residence A');

            const booking = await pool.query(
                'SELECT status, checked_in_at FROM bookings WHERE token = $1',
                [reserved.body.booking.token]
            );
            assert.equal(booking.rows[0].status, 'confirmed');
            assert.ok(booking.rows[0].checked_in_at);
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'occupied');
        });

        it('rejects a student token', async () => {
            const student = await registerStudent({ email: 'verify.denied@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));

            const res = await request(app)
                .post('/api/staff/verify')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ token: 'CPUT-does-not-matter' });

            assert.equal(res.status, 403);
            assert.equal(res.body.error, 'Access denied. Staff privileges required.');
        });

        it('rejects an unknown booking token', async () => {
            const staff = await registerAndLoginStaff({ email: 'verify.missing@mycput.ac.za' });
            const res = await request(app)
                .post('/api/staff/verify')
                .set('Authorization', `Bearer ${staff.token}`)
                .send({ token: 'CPUT-not-a-real-booking' });

            assert.equal(res.status, 404);
            assert.equal(res.body.error, 'Invalid token. No booking found.');
        });
    });

    describe('72-hour expiry worker', () => {
        it('expires a pending booking whose window has passed and frees a reserved room', async () => {
            const student = await registerStudent({ email: 'expire.pending@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();
            await pool.query(`UPDATE rooms SET status = 'reserved' WHERE id = $1`, [roomId]);
            await pool.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
                 VALUES ($1, $2, 'CPUT-expiredpending01', 'pending', NOW() - INTERVAL '1 hour')`,
                [student.body.user.id, roomId]
            );

            await releaseExpiredBookings();

            const booking = await pool.query(`SELECT status FROM bookings WHERE token = 'CPUT-expiredpending01'`);
            assert.equal(booking.rows[0].status, 'expired');
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'available');
        });

        it('leaves a pending booking that has not reached expires_at', async () => {
            const student = await registerStudent({ email: 'expire.future@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();
            await pool.query(`UPDATE rooms SET status = 'reserved' WHERE id = $1`, [roomId]);
            await pool.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
                 VALUES ($1, $2, 'CPUT-stillpending0001', 'pending', NOW() + INTERVAL '71 hours')`,
                [student.body.user.id, roomId]
            );

            await releaseExpiredBookings();

            const booking = await pool.query(`SELECT status FROM bookings WHERE token = 'CPUT-stillpending0001'`);
            assert.equal(booking.rows[0].status, 'pending');
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'reserved');
        });

        it('does not expire a confirmed booking or free an occupied room', async () => {
            const student = await registerStudent({ email: 'expire.confirmed@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();
            await pool.query(`UPDATE rooms SET status = 'occupied' WHERE id = $1`, [roomId]);
            await pool.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at, checked_in_at)
                 VALUES ($1, $2, 'CPUT-confirmedpast01', 'confirmed', NOW() - INTERVAL '1 hour', NOW())`,
                [student.body.user.id, roomId]
            );

            await releaseExpiredBookings();

            const booking = await pool.query(`SELECT status FROM bookings WHERE token = 'CPUT-confirmedpast01'`);
            assert.equal(booking.rows[0].status, 'confirmed');
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'occupied');
        });

        it('expires a pending booking without marking an occupied room available', async () => {
            const student = await registerStudent({ email: 'expire.occupied@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();
            await pool.query(`UPDATE rooms SET status = 'occupied' WHERE id = $1`, [roomId]);
            await pool.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
                 VALUES ($1, $2, 'CPUT-pendingoccupied1', 'pending', NOW() - INTERVAL '2 hours')`,
                [student.body.user.id, roomId]
            );

            await releaseExpiredBookings();

            const booking = await pool.query(`SELECT status FROM bookings WHERE token = 'CPUT-pendingoccupied1'`);
            assert.equal(booking.rows[0].status, 'expired');
            const room = await pool.query('SELECT status FROM rooms WHERE id = $1', [roomId]);
            assert.equal(room.rows[0].status, 'occupied');
        });

        it('lets the student reserve again after the active booking expires', async () => {
            const student = await registerStudent({ email: 'expire.rebook@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            const { roomId } = await seedRoom();
            await pool.query(`UPDATE rooms SET status = 'reserved' WHERE id = $1`, [roomId]);
            await pool.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
                 VALUES ($1, $2, 'CPUT-rebookexpired01', 'pending', NOW() - INTERVAL '5 minutes')`,
                [student.body.user.id, roomId]
            );

            await releaseExpiredBookings();

            const res = await request(app)
                .post('/api/rooms/reserve')
                .set('Authorization', `Bearer ${student.body.token}`)
                .send({ room_id: roomId });

            assert.equal(res.status, 201, JSON.stringify(res.body));
            assert.equal(res.body.booking.status, 'pending');
            const active = await pool.query(
                `SELECT COUNT(*)::int AS count FROM bookings
                 WHERE student_id = $1 AND status IN ('pending', 'confirmed')`,
                [student.body.user.id]
            );
            assert.equal(active.rows[0].count, 1);
        });
    });

    describe('auth hardening', () => {
        it('rejects a missing Authorization header', async () => {
            const res = await request(app).get('/api/rooms');
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Access denied. No token provided.');
        });

        it('rejects a malformed Bearer token', async () => {
            const malformed = ['Bearer', 'Bearer ', 'Bearer one two', 'Basic abcdef', 'Token abc'];
            for (const header of malformed) {
                const res = await request(app).get('/api/rooms').set('Authorization', header);
                assert.equal(res.status, 401, header);
                assert.equal(res.body.error, 'Access denied. Invalid Authorization header.');
            }

            const garbage = await request(app).get('/api/rooms').set('Authorization', 'Bearer not-a-jwt');
            assert.equal(garbage.status, 401);
            assert.equal(garbage.body.error, 'Invalid token.');
        });

        it('rejects an expired JWT', async () => {
            const student = await seedPiiStudent();
            const res = await request(app)
                .get('/api/rooms')
                .set('Authorization', `Bearer ${expiredToken(student.user)}`);

            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Token expired.');
        });

        it('rejects an alg none token and an alg-confused token', async () => {
            const student = await seedPiiStudent();
            for (const alg of ['none', 'None']) {
                const res = await request(app)
                    .get('/api/rooms')
                    .set('Authorization', `Bearer ${unsignedToken(student.user, alg)}`);
                assert.equal(res.status, 401, alg);
                assert.equal(res.body.error, 'Invalid token.');
            }

            const hs384 = jwt.sign(
                { id: student.user.id, email: student.user.email, role: 'student' },
                process.env.JWT_SECRET,
                { algorithm: 'HS384', expiresIn: '1h' }
            );
            const confused = await request(app)
                .get('/api/rooms')
                .set('Authorization', `Bearer ${hs384}`);
            assert.equal(confused.status, 401);
            assert.equal(confused.body.error, 'Invalid token.');
        });

        it('rejects a token after the account role no longer matches', async () => {
            const student = await registerStudent({ email: 'role.changed@mycput.ac.za' });
            assert.equal(student.status, 201, JSON.stringify(student.body));
            await pool.query(`UPDATE users SET role = 'staff' WHERE id = $1`, [student.body.user.id]);

            const res = await request(app)
                .get('/api/rooms')
                .set('Authorization', `Bearer ${student.body.token}`);

            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Invalid token. Account no longer matches this token.');
        });
    });

    describe('GET /api/users', () => {
        it('does not list student PII without an Authorization header', async () => {
            await seedPiiStudent();
            const res = await request(app).get('/api/users');
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Access denied. No token provided.');
            assertNoLeakedPii(res);
        });

        it('does not list student PII for a malformed Bearer token', async () => {
            await seedPiiStudent();
            const res = await request(app).get('/api/users').set('Authorization', 'Bearer one two');
            assert.equal(res.status, 401);
            assertNoLeakedPii(res);
        });

        it('does not list student PII for an expired JWT', async () => {
            const student = await seedPiiStudent();
            const res = await request(app)
                .get('/api/users')
                .set('Authorization', `Bearer ${expiredToken(student.user)}`);
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Token expired.');
            assertNoLeakedPii(res);
        });

        it('does not list student PII for an alg none token', async () => {
            const student = await seedPiiStudent();
            const res = await request(app)
                .get('/api/users')
                .set('Authorization', `Bearer ${unsignedToken(student.user, 'none')}`);
            assert.equal(res.status, 401);
            assert.equal(res.body.error, 'Invalid token.');
            assertNoLeakedPii(res);
        });

        it('does not list student PII for a student token', async () => {
            const student = await seedPiiStudent();
            const res = await request(app)
                .get('/api/users')
                .set('Authorization', `Bearer ${student.token}`);
            assert.equal(res.status, 403);
            assert.equal(res.body.error, 'Access denied. Staff privileges required.');
            assertNoLeakedPii(res);
        });

        it('lists users for a staff token and omits password hashes', async () => {
            await seedPiiStudent();
            const staff = await registerAndLoginStaff({ email: 'users.staff@mycput.ac.za' });
            const res = await request(app)
                .get('/api/users')
                .set('Authorization', `Bearer ${staff.token}`);

            assert.equal(res.status, 200);
            assert.equal(res.body.success, true);
            assert.ok(Array.isArray(res.body.users));
            assert.ok(res.body.users.some((user) => user.email === PII.email && user.full_name === PII.full_name));
            assert.equal(JSON.stringify(res.body).includes('password_hash'), false);
            assert.equal(JSON.stringify(res.body).includes(PII.student_number), false);
        });
    });
});
