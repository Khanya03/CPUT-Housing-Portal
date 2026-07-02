require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// ---------- CREATE UPLOADS FOLDER IF IT DOESN'T EXIST ----------
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// ---------- MULTER CONFIGURATION ----------
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.pdf') {
        return cb(new Error('Only PDF files are allowed.'), false);
    }
    if (file.mimetype !== 'application/pdf') {
        return cb(new Error('Invalid file type. Only PDFs are accepted.'), false);
    }
    cb(null, true);
};

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 8 * 1024 * 1024
    },
    fileFilter: fileFilter
});

// ---------- JWT AUTHENTICATION MIDDLEWARE ----------
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
        console.error('Database connection error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------- GET ALL USERS (For testing only) ----------
app.get('/api/users', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, email, full_name, student_number, role, declared_registration, declared_residence, campus_id, created_at FROM users');
        res.json({ success: true, users: result.rows });
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ---------- STEP 1: STUDENT REGISTRATION ----------
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, full_name, student_number } = req.body;

        if (!email || !email.endsWith('@mycput.ac.za')) {
            return res.status(400).json({ 
                error: 'Only @mycput.ac.za email addresses are allowed to register.' 
            });
        }

        if (!password || !full_name || !student_number) {
            return res.status(400).json({ 
                error: 'Missing required fields: password, full_name, or student_number.' 
            });
        }

        const existingUser = await pool.query(
            'SELECT id FROM users WHERE email = $1',
            [email]
        );
        if (existingUser.rows.length > 0) {
            return res.status(409).json({ error: 'This email is already registered.' });
        }

        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        const newUser = await pool.query(
            `INSERT INTO users (email, password_hash, role, full_name, student_number)
             VALUES ($1, $2, 'student', $3, $4)
             RETURNING id, email, full_name, student_number, created_at`,
            [email, hashedPassword, full_name, student_number]
        );

        const user = newUser.rows[0];

        const token = jwt.sign(
            { id: user.id, email: user.email, role: 'student' },
            process.env.JWT_SECRET || 'fallback-secret-key-change-me',
            { expiresIn: '7d' }
        );

        res.status(201).json({
            message: 'Student registered successfully!',
            user: {
                id: user.id,
                email: user.email,
                full_name: user.full_name,
                student_number: user.student_number,
            },
            token,
        });

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Internal server error during registration.' });
    }
});

// ---------- STEP 2: DUAL-CHECKBOX DECLARATION ----------
app.post('/api/checkin/declaration', verifyToken, async (req, res) => {
    try {
        const { declared_registration, declared_residence } = req.body;
        const userId = req.user.id;

        if (declared_registration !== true || declared_residence !== true) {
            return res.status(400).json({ 
                error: 'Both registration and residence declarations must be confirmed (true).' 
            });
        }

        const result = await pool.query(
            `UPDATE users 
             SET declared_registration = $1, declared_residence = $2 
             WHERE id = $3 
             RETURNING id, email, full_name, declared_registration, declared_residence`,
            [declared_registration, declared_residence, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        res.json({
            message: 'Declarations updated successfully! You can now proceed to upload your documents.',
            user: result.rows[0]
        });

    } catch (error) {
        console.error('Declaration error:', error);
        res.status(500).json({ error: 'Internal server error during declaration.' });
    }
});

// ---------- STEP 3: DOCUMENT UPLOAD (PDF with 8MB limit & binary validation) ----------
app.post('/api/checkin/upload', verifyToken, upload.single('proof'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded. Please upload your proof of registration (PDF).' });
        }

        const userId = req.user.id;
        const file = req.file;

        const fileBuffer = fs.readFileSync(file.path);
        const magicBytes = fileBuffer.slice(0, 4).toString('utf8');
        
        if (magicBytes !== '%PDF') {
            fs.unlinkSync(file.path);
            return res.status(400).json({ 
                error: 'Invalid file format. Binary validation failed. Only genuine PDF files are accepted.' 
            });
        }

        const existingDoc = await pool.query(
            'SELECT id FROM documents WHERE student_id = $1',
            [userId]
        );

        let result;
        if (existingDoc.rows.length > 0) {
            result = await pool.query(
                `UPDATE documents 
                 SET file_name = $1, file_size_bytes = $2, file_path = $3, is_validated = TRUE, uploaded_at = NOW()
                 WHERE student_id = $4
                 RETURNING id, student_id, file_name, file_size_bytes, uploaded_at, is_validated`,
                [file.originalname, file.size, file.path, userId]
            );
        } else {
            result = await pool.query(
                `INSERT INTO documents (student_id, file_name, file_size_bytes, file_path, is_validated)
                 VALUES ($1, $2, $3, $4, TRUE)
                 RETURNING id, student_id, file_name, file_size_bytes, uploaded_at, is_validated`,
                [userId, file.originalname, file.size, file.path]
            );
        }

        res.status(201).json({
            message: 'Document uploaded and validated successfully!',
            document: {
                id: result.rows[0].id,
                file_name: result.rows[0].file_name,
                file_size_bytes: result.rows[0].file_size_bytes,
                uploaded_at: result.rows[0].uploaded_at,
                is_validated: result.rows[0].is_validated
            }
        });

    } catch (error) {
        console.error('Upload error:', error);
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).json({ error: 'Internal server error during document upload.' });
    }
});

// ---------- STEP 4: VIEW ROOMS (COLOR-CODED GRID) ----------
app.get('/api/rooms', verifyToken, async (req, res) => {
    try {
        const userId = req.user.id;

        const userResult = await pool.query(
            'SELECT campus_id FROM users WHERE id = $1',
            [userId]
        );

        if (userResult.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const campusId = userResult.rows[0].campus_id;

        if (!campusId) {
            return res.status(400).json({ 
                error: 'Student has no campus allocation. Please contact administration.' 
            });
        }

        const result = await pool.query(
            `SELECT 
                r.id AS room_id,
                r.room_number,
                r.floor,
                r.status,
                res.id AS residence_id,
                res.name AS residence_name
             FROM rooms r
             JOIN residences res ON r.residence_id = res.id
             WHERE res.campus_id = $1
             ORDER BY res.name, r.floor, r.room_number`,
            [campusId]
        );

        const residences = {};
        result.rows.forEach(row => {
            if (!residences[row.residence_id]) {
                residences[row.residence_id] = {
                    id: row.residence_id,
                    name: row.residence_name,
                    rooms: []
                };
            }

            let color = 'Slate';
            if (row.status === 'available') color = 'Green';
            else if (row.status === 'reserved') color = 'Amber';
            else if (row.status === 'occupied') color = 'Slate';

            residences[row.residence_id].rooms.push({
                id: row.room_id,
                number: row.room_number,
                floor: row.floor,
                status: row.status,
                color: color
            });
        });

        res.json({
            success: true,
            campus_id: campusId,
            residences: Object.values(residences)
        });

    } catch (error) {
        console.error('Fetch rooms error:', error);
        res.status(500).json({ error: 'Internal server error fetching rooms.' });
    }
});

// ---------- STEP 5: RESERVE A ROOM (WITH ATOMIC LOCKING) ----------
app.post('/api/rooms/reserve', verifyToken, async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { room_id } = req.body;
        const userId = req.user.id;

        if (!room_id) {
            return res.status(400).json({ error: 'room_id is required.' });
        }

        const existingBooking = await client.query(
            `SELECT id, status FROM bookings 
             WHERE student_id = $1 AND status IN ('pending', 'confirmed')`,
            [userId]
        );

        if (existingBooking.rows.length > 0) {
            return res.status(400).json({ 
                error: 'You already have an active booking. Only one booking per student is allowed.' 
            });
        }

        await client.query('BEGIN');

        const roomResult = await client.query(
            `SELECT id, room_number, status, residence_id 
             FROM rooms 
             WHERE id = $1 
             FOR UPDATE`,
            [room_id]
        );

        if (roomResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Room not found.' });
        }

        const room = roomResult.rows[0];

        if (room.status !== 'available') {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                error: `Room ${room.room_number} is not available. Current status: ${room.status}` 
            });
        }

        const tokenPrefix = 'CPUT';
        const tokenNumber = String(Math.floor(100000 + Math.random() * 900000));
        const token = `${tokenPrefix}-${tokenNumber}`;

        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 72);

        const bookingResult = await client.query(
            `INSERT INTO bookings (student_id, room_id, token, status, expires_at)
             VALUES ($1, $2, $3, 'pending', $4)
             RETURNING id, token, status, created_at, expires_at`,
            [userId, room_id, token, expiresAt]
        );

        await client.query(
            `UPDATE rooms SET status = 'reserved' WHERE id = $1`,
            [room_id]
        );

        await client.query('COMMIT');

        const booking = bookingResult.rows[0];

        res.status(201).json({
            success: true,
            message: 'Room reserved successfully!',
            booking: {
                id: booking.id,
                token: booking.token,
                status: booking.status,
                created_at: booking.created_at,
                expires_at: booking.expires_at,
                room: {
                    id: room.id,
                    number: room.room_number,
                    residence_id: room.residence_id
                }
            },
            expires_in: '72 hours'
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Reservation error:', error);
        res.status(500).json({ error: 'Internal server error during room reservation.' });
    } finally {
        client.release();
    }
});

// ---------- Multer error handler ----------
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        if (error.code === 'FILE_TOO_LARGE') {
            return res.status(400).json({ error: 'File size exceeds 8MB limit.' });
        }
        return res.status(400).json({ error: error.message });
    }
    if (error.message && error.message.includes('Only PDF')) {
        return res.status(400).json({ error: error.message });
    }
    next(error);
});

// ---------- ROOT ENDPOINT ----------
app.get('/', (req, res) => {
    res.json({ message: 'CPUT Housing Portal API is running!' });
});

// Start the server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Uploads directory: ${path.resolve(uploadDir)}`);
});