require('dotenv').config();
const { Pool } = require('pg');

console.log('[WORKER] Starting...');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'cput_housing',
    password: process.env.DB_PASSWORD || 'postgres',
    port: process.env.DB_PORT || 5432,
});

console.log('[WORKER] DB config loaded.');

async function releaseExpiredBookings() {
    const client = await pool.connect();
    try {
        console.log(`[${new Date().toISOString()}] Checking for expired bookings...`);

        const expiredBookings = await client.query(
            `SELECT id, room_id, student_id, token 
             FROM bookings 
             WHERE status = 'pending' AND expires_at < NOW()`
        );

        if (expiredBookings.rows.length === 0) {
            console.log(`[${new Date().toISOString()}] No expired bookings found.`);
            return;
        }

        console.log(`[${new Date().toISOString()}] Found ${expiredBookings.rows.length} expired booking(s).`);

        await client.query('BEGIN');

        for (const booking of expiredBookings.rows) {
            await client.query(
                `UPDATE bookings SET status = 'expired' WHERE id = $1`,
                [booking.id]
            );
            await client.query(
                `UPDATE rooms SET status = 'available' WHERE id = $1`,
                [booking.room_id]
            );
            console.log(`[${new Date().toISOString()}] Released room ${booking.room_id} (Booking: ${booking.token})`);
        }

        await client.query('COMMIT');
        console.log(`[${new Date().toISOString()}] Successfully released ${expiredBookings.rows.length} room(s).`);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`[${new Date().toISOString()}] Worker error:`, error);
    } finally {
        client.release();
    }
}

// Run once immediately
releaseExpiredBookings();

// Then every 5 minutes
setInterval(releaseExpiredBookings, 5 * 60 * 1000);

console.log(`[${new Date().toISOString()}] Worker started. Checking every 5 minutes.`);