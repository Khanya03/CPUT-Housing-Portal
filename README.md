# 🏠 CPUT Housing Portal — Backend API

A comprehensive student self-check-in system for CPUT residences, built with **Node.js**, **Express**, and **PostgreSQL**.

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Features](#-features)
- [Tech Stack](#️-tech-stack)
- [Prerequisites](#-prerequisites)
- [Installation & Setup](#-installation--setup)
- [Database Schema](#-database-schema)
- [API Endpoints](#-api-endpoints)
- [Example Requests & Responses](#-example-requests--responses)
- [Background Worker](#️-background-worker)
- [Testing the Full Flow](#-testing-the-full-flow)
- [Project Structure](#-project-structure)
- [Troubleshooting](#-troubleshooting)
- [Next Steps](#-next-steps)
- [License](#-license)
- [Acknowledgments](#-acknowledgments)

---

## 📖 Overview

The **CPUT Housing Portal** is a digital check-in system that shifts all administrative tasks — registration confirmation, document submission, and room selection — to an asynchronous self-service interface completed *before* the student physically arrives on campus.

By the time the student walks into the residence, the only remaining step is a quick reference token verification at the help desk — eliminating queues entirely and reducing desk interaction to seconds per student.

---

## ✨ Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Student Registration** | Only `@mycput.ac.za` emails allowed. Passwords securely hashed with bcrypt. |
| 2 | **Dual-Checkbox Declaration** | Students must confirm both registration **and** residence allocation before proceeding. |
| 3 | **PDF Document Upload** | 8MB limit, binary validation (magic bytes) to prevent spoofed files. |
| 4 | **Color-Coded Room Grid** | 🟢 Green = Available · 🟡 Amber = Reserved · ⚪ Slate = Occupied. Campus-bound viewing. |
| 5 | **Room Reservation** | Atomic row-level locking prevents double-booking. Generates a `CPUT-XXXXXX` token. |
| 6 | **72-Hour Background Worker** | Automatically releases expired bookings and frees rooms. Runs every 5 minutes. |
| 7 | **Staff Check-In Verification** | Staff verify tokens at the help desk. Confirms booking and marks room as occupied. |

---

## 🛠️ Tech Stack

| Component | Technology |
|---|---|
| Backend | Node.js + Express.js |
| Database | PostgreSQL 18 |
| Authentication | JWT (JSON Web Tokens) |
| File Upload | Multer |
| Password Hashing | bcrypt |
| Environment Variables | dotenv |
| Process Manager | PM2 (recommended for production) |
| Testing | Thunder Client (VS Code extension) |

---

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

- [Node.js](https://nodejs.org/) (v22 or later)
- npm (comes with Node.js)
- [PostgreSQL 18](https://www.postgresql.org/) (or later)
- [VS Code](https://code.visualstudio.com/) (recommended) with the Thunder Client extension

---

## 🚀 Installation & Setup

### 1. Clone or create the project folder

```bash
mkdir cput-housing-backend
cd cput-housing-backend
```

### 2. Initialize the Node.js project

```bash
npm init -y
```

### 3. Install dependencies

```bash
npm install express pg dotenv cors bcrypt jsonwebtoken multer
npm install -D nodemon
```

### 4. Set up the PostgreSQL database

**Create the database:**

```bash
psql -U postgres -c "CREATE DATABASE cput_housing;"
```

**Run the schema** (copy from `/schema.sql`). The schema creates 6 tables: `users`, `campuses`, `residences`, `rooms`, `documents`, `bookings`.

```sql
\c cput_housing;
-- Paste the full schema SQL here (provided separately)
```

**Insert sample data:**

```sql
INSERT INTO campuses (name, location) VALUES 
('Cape Town Campus', 'Cape Town CBD'),
('Bellville Campus', 'Bellville'),
('Wellington Campus', 'Wellington');

INSERT INTO residences (campus_id, name, address) VALUES 
(1, 'Cape Town Residence A', '123 Main St, Cape Town'),
(1, 'Cape Town Residence B', '456 Long St, Cape Town'),
(2, 'Bellville Residence A', '789 Durban Rd, Bellville'),
(3, 'Wellington Residence A', '101 Church St, Wellington');

INSERT INTO rooms (residence_id, room_number, floor, status) VALUES 
(3, '101', 1, 'available'),
(3, '102', 1, 'available'),
(3, '103', 1, 'available'),
(3, '104', 1, 'available'),
(3, '105', 1, 'available'),
(3, '201', 2, 'available'),
(3, '202', 2, 'available'),
(3, '203', 2, 'available'),
(3, '204', 2, 'available'),
(3, '205', 2, 'available');
```

**Add declaration columns:**

```sql
ALTER TABLE users ADD COLUMN declared_registration BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN declared_residence BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN campus_id INTEGER REFERENCES campuses(id);
```

### 5. Create the `.env` file

Create a `.env` file in the project root:

```env
PORT=3000
DB_USER=postgres
DB_HOST=localhost
DB_NAME=cput_housing
DB_PASSWORD=your_password
DB_PORT=5432
JWT_SECRET=your-super-secret-jwt-key-change-me
```

### 6. Create the uploads folder

```bash
mkdir uploads
```

### 7. Start the server

```bash
npm run dev
```

You should see:

```text
Server running on http://localhost:3000
Uploads directory: C:\...\cput-housing-backend\uploads
```

---

## 📊 Database Schema

### Tables

| Table | Description |
|---|---|
| `users` | Students and staff accounts |
| `campuses` | University campuses (Cape Town, Bellville, Wellington) |
| `residences` | Residences belonging to campuses |
| `rooms` | Individual rooms with status (available/reserved/occupied) |
| `documents` | Uploaded PDF proofs of registration |
| `bookings` | Room bookings with tokens and expiry dates |

### Enums

| Enum | Values |
|---|---|
| `user_role` | `student`, `staff` |
| `room_status` | `available`, `reserved`, `occupied` |
| `booking_status` | `pending`, `confirmed`, `expired`, `cancelled` |

---

## 🔌 API Endpoints

### Authentication

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/auth/register` | Register a new student | ❌ |
| `POST` | `/api/auth/login` | Login (student or staff) | ❌ |

### Student Flow

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/checkin/declaration` | Dual-checkbox declaration | ✅ Student |
| `POST` | `/api/checkin/upload` | Upload PDF proof of registration | ✅ Student |
| `GET` | `/api/rooms` | View color-coded room grid | ✅ Student |
| `POST` | `/api/rooms/reserve` | Reserve a room (atomic locking) | ✅ Student |

### Staff Flow

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/api/staff/verify` | Verify booking token at check-in | ✅ Staff |

### Testing

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `GET` | `/api/test-db` | Test database connection | ❌ |
| `GET` | `/api/users` | View all users | ❌ |
| `GET` | `/` | API status | ❌ |

---

## 📝 Example Requests & Responses

### 1. Register a Student

**Request**

```json
POST /api/auth/register
{
    "email": "student@mycput.ac.za",
    "password": "SecurePassword123",
    "full_name": "John Doe",
    "student_number": "12345678"
}
```

**Response**

```json
{
    "message": "Student registered successfully!",
    "user": {
        "id": 1,
        "email": "student@mycput.ac.za",
        "full_name": "John Doe",
        "student_number": "12345678"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 2. Login (Student or Staff)

**Request**

```json
POST /api/auth/login
{
    "email": "staff.helpdesk@cput.ac.za",
    "password": "Staff12345"
}
```

**Response**

```json
{
    "message": "Login successful!",
    "user": {
        "id": 2,
        "email": "staff.helpdesk@cput.ac.za",
        "full_name": "Help Desk Staff",
        "role": "staff"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

### 3. Room Reservation (Atomic Locking)

**Request**

```json
POST /api/rooms/reserve
Authorization: Bearer <student_token>
{
    "room_id": 1
}
```

**Response**

```json
{
    "success": true,
    "message": "Room reserved successfully!",
    "booking": {
        "id": 1,
        "token": "CPUT-348330",
        "status": "pending",
        "created_at": "2026-07-02T17:08:45.818Z",
        "expires_at": "2026-07-05T17:08:45.826Z",
        "room": {
            "id": 1,
            "number": "101",
            "residence_id": 3
        }
    },
    "expires_in": "72 hours"
}
```

### 4. Staff Verification

**Request**

```json
POST /api/staff/verify
Authorization: Bearer <staff_token>
{
    "token": "CPUT-348330"
}
```

**Response**

```json
{
    "success": true,
    "message": "Check-in successful! Access granted.",
    "student": {
        "id": 1,
        "name": "John Doe",
        "student_number": "12345678",
        "email": "student@mycput.ac.za"
    },
    "room": {
        "number": "101",
        "residence": "Bellville Residence A"
    }
}
```

### 5. View Rooms (Color-Coded Grid)

**Request**

```json
GET /api/rooms
Authorization: Bearer <student_token>
```

**Response**

```json
{
    "success": true,
    "campus_id": 2,
    "residences": [
        {
            "id": 3,
            "name": "Bellville Residence A",
            "rooms": [
                {
                    "id": 1,
                    "number": "101",
                    "floor": 1,
                    "status": "available",
                    "color": "Green"
                }
            ]
        }
    ]
}
```

---

## ⚙️ Background Worker

`worker.js` runs every 5 minutes and:

1. Finds all pending bookings where `expires_at < NOW()`
2. Updates booking status to `expired`
3. Releases the room back to `available`

### Start the worker

```bash
node worker.js
```

### Worker output example

```text
[2026-07-02T17:20:00.000Z] Worker started. Checking every 5 minutes.
[2026-07-02T17:20:00.000Z] Checking for expired bookings...
[2026-07-02T17:20:00.000Z] No expired bookings found.
[2026-07-02T17:25:00.000Z] Checking for expired bookings...
[2026-07-02T17:25:00.000Z] Found 1 expired booking(s).
[2026-07-02T17:25:00.000Z] Released room 1 (Booking: CPUT-348330)
[2026-07-02T17:25:00.000Z] Successfully released 1 room(s).
```

---

## 🧪 Testing the Full Flow

Step-by-step test:

1. **Register a student** → `POST /api/auth/register` → Get student token
2. **Assign campus** → `UPDATE users SET campus_id = 2 WHERE email = '...'`
3. **Declare** → `POST /api/checkin/declaration` (with student token)
4. **Upload PDF** → `POST /api/checkin/upload` (with student token)
5. **View rooms** → `GET /api/rooms` (with student token)
6. **Reserve room** → `POST /api/rooms/reserve` (with student token) → Get booking token
7. **Login as staff** → `POST /api/auth/login` → Get staff token
8. **Verify booking** → `POST /api/staff/verify` (with staff token + booking token)

---

## 📁 Project Structure

```text
cput-housing-backend/
├── server.js              # Main API (all 7 steps + login)
├── worker.js              # 72-hour background worker
├── .env                   # Environment variables
├── package.json           # Dependencies and scripts
├── package-lock.json      # Locked dependencies
├── uploads/               # PDF storage folder
└── node_modules/          # Node packages (generated)
```

---

## 🔧 Troubleshooting

### Common Issues & Solutions

| Issue | Solution |
|---|---|
| `psql: command not found` | Add PostgreSQL to PATH: `set PATH=%PATH%;C:\Program Files\PostgreSQL\18\bin` |
| `Access denied. No token provided.` | Add `Authorization: Bearer <token>` header |
| `Access denied. Staff privileges required.` | Login as staff and use a fresh token (role is embedded in the JWT) |
| Token expired | Re-book a room or wait for the worker to release it |
| `403 Forbidden` on localhost | Try port `3000` instead of `5000`, or use `127.0.0.1` |
| `Only @mycput.ac.za emails allowed` | Registration is student-only. Create staff by promoting a student in the DB. |
| `This email is already registered` | Use a unique email for each test registration |

### Useful Database Commands

```sql
-- Check all users
SELECT id, email, role, campus_id FROM users;

-- Check all bookings
SELECT id, token, status, room_id, expires_at FROM bookings;

-- Check room statuses
SELECT id, room_number, status FROM rooms;

-- Promote a user to staff
UPDATE users SET role = 'staff', student_number = NULL WHERE email = '...';

-- Manually expire a booking (for testing)
UPDATE bookings SET expires_at = NOW() - interval '1 minute' WHERE token = 'CPUT-XXXXXX';
```

---

## 🚀 Next Steps

### 1. Build the mobile app (student side)

- Recommended: **Flutter** or **React Native**
- Connect to API endpoints
- Implement the 7-step flow as a mobile UI
- Show color-coded room grid (Green/Amber/Slate)

### 2. Build the staff web dashboard

- Recommended: **React.js** or **Vue.js**
- Staff login
- Token verification interface
- Live occupancy dashboard
- Diagnostic tools

### 3. Deploy to production

**Option A: Manual deployment**

```bash
# Using PM2 to keep processes running
npm install -g pm2
pm2 start server.js --name api
pm2 start worker.js --name worker
pm2 save
pm2 startup
```

**Option B: Cloud platforms**

- Backend: Railway, Render, or AWS EC2
- Database: AWS RDS, DigitalOcean Managed PostgreSQL, or Supabase
- File Storage: AWS S3 or Cloudinary (instead of local `uploads/`)

### 4. Add more features

- Email notifications (nodemailer)
- Payment integration
- Waitlist functionality
- Room swap requests
- Student profile management
- Admin dashboard

---

## 📝 License

This project was built for educational purposes as part of the CPUT Housing Portal system.

## 🙏 Acknowledgments

- CPUT for the business requirements
- PostgreSQL for robust database capabilities
- The open-source community for making great tools

---

*Built with ❤️ for CPUT students and staff*
