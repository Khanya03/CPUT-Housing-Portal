require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

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

// ---------- JWT MIDDLEWARE ----------
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback-secret-key-change-me');
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
};

// ---------- STAFF MIDDLEWARE ----------
const verifyStaff = (req, res, next) => {
    if (req.user.role !== 'staff') {
        return res.status(403).json({ error: 'Access denied. Staff privileges required.' });
    }
    next();
};

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

// ---------- GET ALL USERS ----------
app.get('/api/users', async (req, res) => {
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
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required.' });
        }

        const userResult = await pool.query(
            'SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1',
            [email]
        );

        if (userResult.rows.length === 0) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const user = userResult.rows[0];

        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }

        const token = jwt.sign(
            { id: user.id, email: user.email, role: user.role },
            process.env.JWT_SECRET || 'fallback-secret-key-change-me',
            { expiresIn: '7d' }
        );

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
        const { email, password, full_name, student_number } = req.body;

        if (!email || !email.endsWith('@mycput.ac.za')) {
            return res.status(400).json({ error: 'Only @mycput.ac.za emails allowed.' });
        }
        if (!password || !full_name || !student_number) {
            return res.status(400).json({ error: 'Missing required fields.' });
        }

        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            return res.status(409).json({ error: 'Email already registered.' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await pool.query(
            `INSERT INTO users (email, password_hash, role, full_name, student_number)
             VALUES ($1, $2, 'student', $3, $4)
             RETURNING id, email, full_name, student_number`,
            [email, hashedPassword, full_name, student_number]
        );

        const user = newUser.rows[0];
        const token = jwt.sign(
            { id: user.id, email: user.email, role: 'student' },
            process.env.JWT_SECRET || 'fallback-secret-key-change-me',
            { expiresIn: '7d' }
        );

        res.status(201).json({ message: 'Registered successfully!', user, token });

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error.' });
    }
});

// ---------- STEP 2: DECLARATION ----------
app.post('/api/checkin/declaration', verifyToken, async (req, res) => {
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
app.post('/api/checkin/upload', verifyToken, upload.single('proof'), async (req, res) => {
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
app.get('/api/rooms', verifyToken, async (req, res) => {
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
app.post('/api/rooms/reserve', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { room_id } = req.body;
        const userId = req.user.id;

        if (!room_id) return res.status(400).json({ error: 'room_id required.' });

        const existing = await client.query(
            'SELECT id FROM bookings WHERE student_id = $1 AND status IN ($2, $3)',
            [userId, 'pending', 'confirmed']
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ error: 'You already have an active booking.' });
        }

        await client.query('BEGIN');
        const roomResult = await client.query('SELECT id, room_number, status FROM rooms WHERE id = $1 FOR UPDATE', [room_id]);

        if (roomResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Room not found.' });
        }

        const room = roomResult.rows[0];
        if (room.status !== 'available') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Room ${room.room_number} is not available.` });
        }

        const token = `CPUT-${String(Math.floor(100000 + Math.random() * 900000))}`;
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000);

        const bookingResult = await client.query(
            `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
             VALUES ($1, $2, $3, 'pending', $4)
             RETURNING id, token, status, created_at, expires_at`,
            [userId, room_id, token, expiresAt]
        );

        await client.query('UPDATE rooms SET status = $1 WHERE id = $2', ['reserved', room_id]);
        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Room reserved!',
            booking: bookingResult.rows[0],
            expires_in: '72 hours'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(error);
        res.status(500).json({ error: 'Reservation failed.' });
    } finally {
        client.release();
    }
});

// ---------- STEP 7: STAFF CHECK-IN (TOKEN VERIFICATION) ----------
app.post('/api/staff/verify', verifyToken, verifyStaff, async (req, res) => {
    const client = await pool.connect();
    try {
        const { token } = req.body;

        if (!token) {
            return res.status(400).json({ error: 'Token is required.' });
        }

        // 1. Find the booking with the provided token
        const bookingResult = await client.query(
            `SELECT b.id, b.status, b.expires_at, b.room_id, 
                    u.id AS student_id, u.full_name, u.student_number, u.email,
                    r.room_number, res.name AS residence_name
             FROM bookings b
             JOIN users u ON b.student_id = u.id
             JOIN rooms r ON b.room_id = r.id
             JOIN residences res ON r.residence_id = res.id
             WHERE b.token = $1`,
            [token]
        );

        if (bookingResult.rows.length === 0) {
            return res.status(404).json({ error: 'Invalid token. No booking found.' });
        }

        const booking = bookingResult.rows[0];

        // 2. Check if booking is already confirmed
        if (booking.status === 'confirmed') {
            return res.status(400).json({ error: 'This booking has already been checked in.' });
        }

        // 3. Check if booking is expired
        if (booking.status === 'expired') {
            return res.status(400).json({ error: 'This booking has expired. Please re-book.' });
        }

        // 4. Check if the 72-hour window has passed
        const now = new Date();
        const expiresAt = new Date(booking.expires_at);
        if (now > expiresAt) {
            // Auto-expire it
            await client.query(
                `UPDATE bookings SET status = 'expired' WHERE id = $1`,
                [booking.id]
            );
            await client.query(
                `UPDATE rooms SET status = 'available' WHERE id = $1`,
                [booking.room_id]
            );
            return res.status(400).json({ error: 'Token expired. Room has been released.' });
        }

        // 5. Valid token! Perform check-in
        await client.query('BEGIN');

        // Update booking status to 'confirmed'
        await client.query(
            `UPDATE bookings SET status = 'confirmed', checked_in_at = NOW() WHERE id = $1`,
            [booking.id]
        );

        // Update room status to 'occupied'
        await client.query(
            `UPDATE rooms SET status = 'occupied' WHERE id = $1`,
            [booking.room_id]
        );

        await client.query('COMMIT');

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
        await client.query('ROLLBACK');
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

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Uploads directory: ${path.resolve(uploadDir)}`);
});