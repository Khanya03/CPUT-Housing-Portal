require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
if (typeof JWT_SECRET !== 'string' || JWT_SECRET.trim() === '') {
    console.error('Fatal: JWT_SECRET environment variable is required and must not be empty. Set JWT_SECRET before starting the server.');
    process.exit(1);
}

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BOOKING_TOKEN_BYTES = 16;
const BOOKING_TOKEN_ATTEMPTS = 5;

function generateBookingToken() {
    return `CPUT-${crypto.randomBytes(BOOKING_TOKEN_BYTES).toString('hex')}`;
}

function isBookingTokenConflict(error) {
    if (!error || error.code !== '23505') return false;
    const haystack = `${error.constraint || ''} ${error.column || ''} ${error.detail || ''}`.toLowerCase();
    return haystack.includes('token');
}

// Pre-check uniqueness, then insert. A unique violation aborts the surrounding
// transaction, so retries roll back only to a savepoint.
async function insertBookingWithUniqueToken(client, { userId, roomId, expiresAt }) {
    for (let attempt = 1; attempt <= BOOKING_TOKEN_ATTEMPTS; attempt++) {
        const token = generateBookingToken();
        const clash = await client.query('SELECT 1 FROM bookings WHERE token = $1', [token]);
        if (clash.rows.length > 0) continue;

        await client.query('SAVEPOINT booking_token_insert');
        try {
            const bookingResult = await client.query(
                `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
                 VALUES ($1, $2, $3, 'pending', $4)
                 RETURNING id, token, status, created_at, expires_at`,
                [userId, roomId, token, expiresAt]
            );
            await client.query('RELEASE SAVEPOINT booking_token_insert');
            return bookingResult;
        } catch (error) {
            await client.query('ROLLBACK TO SAVEPOINT booking_token_insert');
            if (isBookingTokenConflict(error) && attempt < BOOKING_TOKEN_ATTEMPTS) continue;
            throw error;
        }
    }

    throw new Error('Could not allocate a unique booking token.');
}

// ---------- CREATE UPLOADS FOLDER ----------
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// ---------- MULTER CONFIGURATION ----------
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') return cb(new Error('Only PDF files are allowed.'), false);
    if (file.mimetype !== 'application/pdf') return cb(new Error('Invalid file type.'), false);
    cb(null, true);
};

const upload = multer({
    storage,
    limits: { fileSize: 8 * 1024 * 1024 },
    fileFilter
});

// ---------- AUTH HELPERS ----------
const PASSWORD_MIN_LENGTH = 8;
// bcrypt only uses the first 72 bytes and throws past that.
const PASSWORD_MAX_BYTES = 72;
const STUDENT_EMAIL_SUFFIX = '@mycput.ac.za';
// Used when login finds no account so the response time does not reveal that.
const DUMMY_PASSWORD_HASH = '$2b$10$7tT60wbt1vRIAkbPYWjOn.2u7ZMNwO8ijUXRFioqYlhjNXRXzQEYW';

function normalizeEmail(email) {
    if (typeof email !== 'string') return null;
    const normalized = email.trim().toLowerCase();
    if (!normalized || normalized.length > 254 || /\s/.test(normalized)) return null;
    return normalized;
}

function isCputStudentEmail(email) {
    return email.endsWith(STUDENT_EMAIL_SUFFIX)
        && email.length > STUDENT_EMAIL_SUFFIX.length
        && !email.slice(0, -STUDENT_EMAIL_SUFFIX.length).includes('@');
}

function parseUserId(value) {
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)) return value;
    return null;
}

function extractBearerToken(authorization) {
    if (authorization == null || (typeof authorization === 'string' && authorization.trim() === '')) {
        return { ok: false, error: 'Access denied. No token provided.' };
    }
    if (typeof authorization !== 'string') {
        return { ok: false, error: 'Access denied. Invalid Authorization header.' };
    }
    const match = authorization.trim().match(/^Bearer\s+(\S+)$/i);
    if (!match) {
        return { ok: false, error: 'Access denied. Invalid Authorization header.' };
    }
    return { ok: true, token: match[1] };
}

function signAuthToken(user) {
    return jwt.sign(
        { id: user.id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: '7d', algorithm: 'HS256' }
    );
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'cput_housing',
    password: process.env.DB_PASSWORD || 'postgres',
    port: process.env.DB_PORT || 5432,
});

// req.user is loaded from the users table after the JWT signature and expiry check.
const verifyToken = async (req, res, next) => {
    const extracted = extractBearerToken(req.headers.authorization);
    if (!extracted.ok) {
        return res.status(401).json({ error: extracted.error });
    }

    let decoded;
    try {
        decoded = jwt.verify(extracted.token, JWT_SECRET, { algorithms: ['HS256'] });
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired.' });
        }
        return res.status(401).json({ error: 'Invalid token.' });
    }

    const userId = parseUserId(decoded && decoded.id);
    const tokenRole = decoded && decoded.role;
    if (!userId || (tokenRole !== 'student' && tokenRole !== 'staff') || typeof decoded.exp !== 'number') {
        return res.status(401).json({ error: 'Invalid token.' });
    }
    if (typeof decoded.email !== 'string') {
        return res.status(401).json({ error: 'Invalid token.' });
    }

    try {
        const result = await pool.query(
            'SELECT id, email, role FROM users WHERE id = $1',
            [userId]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Access denied. User no longer exists.' });
        }
        const user = result.rows[0];
        if (user.role !== tokenRole || String(user.email).toLowerCase() !== decoded.email.toLowerCase()) {
            return res.status(401).json({ error: 'Invalid token. Account no longer matches this token.' });
        }
        req.user = { id: user.id, email: user.email, role: user.role };
        return next();
    } catch (error) {
        console.error('Auth error:', error);
        return res.status(500).json({ error: 'Internal server error.' });
    }
};

const verifyStaff = (req, res, next) => {
    if (!req.user || req.user.role !== 'staff') {
        return res.status(403).json({ error: 'Access denied. Staff privileges required.' });
    }
    next();
};

const verifyStudent = (req, res, next) => {
    if (!req.user || req.user.role !== 'student') {
        return res.status(403).json({ error: 'Access denied. Student privileges required.' });
    }
    next();
};

// ---------- TEST ENDPOINT ----------
app.get('/api/test-db', async (req, res) => {
    try {
        const result = await pool.query('SELECT NOW()');
        res.json({ success: true, time: result.rows[0] });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------- GET ALL USERS (staff only; student PII) ----------
app.get('/api/users', verifyToken, verifyStaff, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, full_name, role, campus_id FROM users');
        res.json({ success: true, users: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------- LOGIN (NEW) ----------
app.post('/api/auth/login', async (req, res) => {
    try {
        const body = req.body || {};
        const email = normalizeEmail(body.email);
        const password = body.password;

        if (!email || typeof password !== 'string' || password.length === 0) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const userResult = await pool.query(
            'SELECT id, email, password_hash, full_name, role FROM users WHERE lower(email) = $1',
            [email]
        );

        const user = userResult.rows.length === 1 ? userResult.rows[0] : null;

        const hash = user && typeof user.password_hash === 'string' && user.password_hash
            ? user.password_hash
            : DUMMY_PASSWORD_HASH;
        const validPassword = await bcrypt.compare(password, hash);
        if (!user || !validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = signAuthToken(user);

        res.json({
            message: 'Login successful!',
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                role: user.role
            },
            token
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ---------- STEP 1: REGISTER ----------
app.post('/api/auth/register', async (req, res) => {
    try {
        const body = req.body || {};
        const email = normalizeEmail(body.email);
        const password = body.password;
        const fullName = typeof body.full_name === 'string' ? body.full_name.trim() : '';
        const studentNumber = typeof body.student_number === 'string' ? body.student_number.trim() : '';

        if (!email || !isCputStudentEmail(email)) {
            return res.status(400).json({ error: 'Only @mycput.ac.za emails allowed.' });
        }
        if (typeof password !== 'string' || password.length === 0 || !fullName || !studentNumber) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }
        if (password.length < PASSWORD_MIN_LENGTH) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
            return res.status(400).json({ error: 'Password must be at most 72 bytes.' });
        }

        const existing = await pool.query('SELECT id FROM users WHERE lower(email) = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Email already registered.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            `INSERT INTO users (email, password_hash, role, full_name, student_number)
             VALUES ($1, $2, 'student', $3, $4)
             RETURNING id, email, full_name, student_number`,
            [email, hashedPassword, fullName, studentNumber]
        );

        const user = newUser.rows[0];
        const token = signAuthToken({ id: user.id, email: user.email, role: 'student' });

        res.status(201).json({ message: 'Registered successfully!', user, token });

    } catch (error) {
        if (error && error.code === '23505') {
            return res.status(409).json({ error: 'Email already registered.' });
        }
        console.error(error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ---------- STEP 2: DECLARATION ----------
app.post('/api/checkin/declaration', verifyToken, verifyStudent, async (req, res) => {
    try {
        const { declared_registration, declared_residence } = req.body;
        const userId = req.user.id;

        if (declared_registration !== true || declared_residence !== true) {
            return res.status(400).json({ error: 'Both declarations must be true.' });
        }

        const result = await pool.query(
            `UPDATE users SET declared_registration = $1, declared_residence = $2 WHERE id = $3
             RETURNING id, email, full_name, declared_registration, declared_residence`,
            [declared_registration, declared_residence, userId]
        );

        res.json({ message: 'Declarations updated!', user: result.rows[0] });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ---------- STEP 3: UPLOAD PDF ----------
app.post('/api/checkin/upload', verifyToken, verifyStudent, upload.single('proof'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        const userId = req.user.id;
        const file = req.file;

        const fileBuffer = fs.readFileSync(file.path);
        if (fileBuffer.slice(0, 4).toString('utf8') !== '%PDF') {
            fs.unlinkSync(file.path);
            return res.status(400).json({ error: 'Invalid PDF file.' });
        }

        const existing = await pool.query('SELECT id FROM documents WHERE student_id = $1', [userId]);
        let result;

        if (existing.rows.length > 0) {
            result = await pool.query(
                `UPDATE documents SET file_name=$1, file_size_bytes=$2, file_path=$3, uploaded_at=NOW()
                 WHERE student_id=$4 RETURNING id, file_name, file_size_bytes, uploaded_at`,
                [file.originalname, file.size, file.path, userId]
            );
        } else {
            result = await pool.query(
                `INSERT INTO documents (student_id, file_name, file_size_bytes, file_path)
                 VALUES ($1, $2, $3, $4) RETURNING id, file_name, file_size_bytes, uploaded_at`,
                [userId, file.originalname, file.size, file.path]
            );
        }

        res.status(201).json({ message: 'Document uploaded!', document: result.rows[0] });

    } catch (error) {
        console.error(error);
        if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(500).json({ error: 'Upload failed.' });
    }
});

// ---------- STEP 4: VIEW ROOMS ----------
app.get('/api/rooms', verifyToken, verifyStudent, async (req, res) => {
    try {
        const userId = req.user.id;
        const userResult = await pool.query('SELECT campus_id FROM users WHERE id = $1', [userId]);
        if (userResult.rows.length === 0) return res.status(404).json({ error: 'User not found.' });

        const campusId = userResult.rows[0].campus_id;
        if (!campusId) return res.status(400).json({ error: 'No campus assigned.' });

        const result = await pool.query(
            `SELECT r.id AS room_id, r.room_number, r.floor, r.status, res.id AS residence_id, res.name AS residence_name
             FROM rooms r JOIN residences res ON r.residence_id = res.id
             WHERE res.campus_id = $1 ORDER BY res.name, r.floor, r.room_number`,
            [campusId]
        );

        const residences = {};
        result.rows.forEach(row => {
            if (!residences[row.residence_id]) {
                residences[row.residence_id] = { id: row.residence_id, name: row.residence_name, rooms: [] };
            }
            let color = 'Slate';
            if (row.status === 'available') color = 'Green';
            else if (row.status === 'reserved') color = 'Amber';
            residences[row.residence_id].rooms.push({
                id: row.room_id,
                number: row.room_number,
                floor: row.floor,
                status: row.status,
                color
            });
        });

        res.json({ success: true, campus_id: campusId, residences: Object.values(residences) });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ---------- STEP 5: RESERVE ROOM ----------
app.post('/api/rooms/reserve', verifyToken, verifyStudent, async (req, res) => {
    const client = await pool.connect();
    let inTransaction = false;
    try {
        const { room_id } = req.body;
        const userId = req.user.id;

        if (!room_id) return res.status(400).json({ error: 'room_id required.' });

        await client.query('BEGIN');
        inTransaction = true;

        // Lock the student row first so two reserves with no booking row yet
        // cannot both pass the "already booked" check. FOR UPDATE on bookings
        // does not lock anything when that SELECT returns zero rows.
        const userLock = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        if (userLock.rows.length === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(404).json({ error: 'User not found.' });
        }

        const existing = await client.query(
            `SELECT id FROM bookings
             WHERE student_id = $1 AND status IN ('pending', 'confirmed')
             FOR UPDATE`,
            [userId]
        );
        if (existing.rows.length > 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: 'You already have an active booking.' });
        }

        const roomResult = await client.query(
            'SELECT id, room_number, status FROM rooms WHERE id = $1 FOR UPDATE',
            [room_id]
        );

        if (roomResult.rows.length === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(404).json({ error: 'Room not found.' });
        }

        const room = roomResult.rows[0];
        if (room.status !== 'available') {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: `Room ${room.room_number} is not available.` });
        }

        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);
        const bookingResult = await insertBookingWithUniqueToken(client, {
            userId,
            roomId: room_id,
            expiresAt
        });

        const reserved = await client.query(
            `UPDATE rooms SET status = 'reserved' WHERE id = $1 AND status = 'available'`,
            [room_id]
        );
        if (reserved.rowCount === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: `Room ${room.room_number} is not available.` });
        }

        await client.query('COMMIT');
        inTransaction = false;

        res.status(201).json({
            success: true,
            message: 'Room reserved!',
            booking: bookingResult.rows[0],
            expires_in: '72 hours'
        });

    } catch (error) {
        if (inTransaction) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error(rollbackError);
            }
        }
        console.error(error);
        res.status(500).json({ error: 'Reservation failed.' });
    } finally {
        client.release();
    }
});

// ---------- STEP 7: STAFF CHECK-IN (TOKEN VERIFICATION) ----------
app.post('/api/staff/verify', verifyToken, verifyStaff, async (req, res) => {
    const client = await pool.connect();
    let inTransaction = false;
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token is required.' });
        }

        await client.query('BEGIN');
        inTransaction = true;

        // Lock only the booking row. Locking the joined user/room here would
        // invert the reserve lock order (user -> booking -> room) and deadlock.
        const bookingResult = await client.query(
            `SELECT b.id, b.status, b.expires_at, b.room_id,
                    u.id AS student_id, u.full_name, u.student_number, u.email,
                    r.room_number, res.name AS residence_name
             FROM bookings b
             JOIN users u ON b.student_id = u.id
             JOIN rooms r ON b.room_id = r.id
             JOIN residences res ON r.residence_id = res.id
             WHERE b.token = $1
             FOR UPDATE OF b`,
            [token]
        );

        if (bookingResult.rows.length === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(404).json({ error: 'Invalid token. No booking found.' });
        }

        const booking = bookingResult.rows[0];

        if (booking.status === 'confirmed') {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: 'This booking has already been checked in.' });
        }

        if (booking.status === 'expired') {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(400).json({ error: 'This booking has expired. Please re-book.' });
        }

        if (booking.status !== 'pending') {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(409).json({ error: 'Booking can no longer be verified.' });
        }

        await client.query('SELECT id FROM rooms WHERE id = $1 FOR UPDATE', [booking.room_id]);

        const now = new Date();
        const expiresAt = new Date(booking.expires_at);
        if (now > expiresAt) {
            const expired = await client.query(
                `UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'pending' RETURNING id`,
                [booking.id]
            );
            if (expired.rowCount > 0) {
                await client.query(
                    `UPDATE rooms SET status = 'available' WHERE id = $1 AND status = 'reserved'`,
                    [booking.room_id]
                );
            }
            await client.query('COMMIT');
            inTransaction = false;
            return res.status(400).json({ error: 'Token expired. Room has been released.' });
        }

        const confirmed = await client.query(
            `UPDATE bookings SET status = 'confirmed', checked_in_at = NOW()
             WHERE id = $1 AND status = 'pending'
             RETURNING id`,
            [booking.id]
        );
        if (confirmed.rowCount === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(409).json({ error: 'Booking is no longer pending and cannot be checked in.' });
        }

        // Do not confirm a booking whose room is not still reserved. Rolling
        // back leaves neither a confirmed booking nor a freed/occupied mismatch.
        const occupied = await client.query(
            `UPDATE rooms SET status = 'occupied' WHERE id = $1 AND status = 'reserved' RETURNING id`,
            [booking.room_id]
        );
        if (occupied.rowCount === 0) {
            await client.query('ROLLBACK');
            inTransaction = false;
            return res.status(409).json({ error: 'Room is not reserved for this booking. Check-in was not applied.' });
        }

        await client.query('COMMIT');
        inTransaction = false;

        res.json({
            success: true,
            message: 'Check-in successful! Access granted.',
            student: {
                id: booking.student_id,
                name: booking.full_name,
                student_number: booking.student_number,
                email: booking.email
            },
            room: {
                number: booking.room_number,
                residence: booking.residence_name
            }
        });

    } catch (error) {
        if (inTransaction) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error(rollbackError);
            }
        }
        console.error('Verification error:', error);
        res.status(500).json({ error: 'Internal server error during verification.' });
    } finally {
        client.release();
    }
});

// ---------- MULTER ERROR HANDLER ----------
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'FILE_TOO_LARGE') return res.status(400).json({ error: 'File exceeds 8MB.' });
        return res.status(400).json({ error: error.message });
    }
    if (error.message && error.message.includes('Only PDF')) {
        return res.status(400).json({ error: error.message });
    }
    next(error);
});

// ---------- ROOT ----------
app.get('/', (req, res) => {
    res.json({ message: 'CPUT Housing Portal API is running!' });
});

module.exports = app;
module.exports.pool = pool;

if (require.main === module) {
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server running on http://localhost:${PORT}`);
        console.log(`Uploads directory: ${path.resolve(uploadDir)}`);
    });
}