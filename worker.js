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
    let inTransaction = false;
    try {
        console.log(`[${new Date().toISOString()}] Checking for expired bookings...`);

        await client.query('BEGIN');
        inTransaction = true;

        // Lock pending rows. In READ COMMITTED, a row confirmed by staff while
        // we wait is re-checked against this WHERE and dropped.
        const expiredBookings = await client.query(
            `SELECT id, room_id, student_id, token
             FROM bookings
             WHERE status = 'pending' AND expires_at < NOW()
             FOR UPDATE`
        );

        if (expiredBookings.rows.length === 0) {
            await client.query('COMMIT');
            inTransaction = false;
            console.log(`[${new Date().toISOString()}] No expired bookings found.`);
            return;
        }

        console.log(`[${new Date().toISOString()}] Found ${expiredBookings.rows.length} expired booking(s).`);

        let released = 0;
        for (const booking of expiredBookings.rows) {
            const updated = await client.query(
                `UPDATE bookings SET status = 'expired'
                 WHERE id = $1 AND status = 'pending'
                 RETURNING id`,
                [booking.id]
            );
            if (updated.rowCount === 0) continue;

            // Only free a room that is still reserved. Never mark an occupied
            // (just checked-in) or otherwise non-reserved room as available.
            const roomUpdate = await client.query(
                `UPDATE rooms SET status = 'available'
                 WHERE id = $1 AND status = 'reserved'
                 RETURNING id`,
                [booking.room_id]
            );
            if (roomUpdate.rowCount === 0) {
                console.log(`[${new Date().toISOString()}] Expired booking ${booking.token} but room ${booking.room_id} was not reserved; left room status unchanged.`);
                continue;
            }
            released += 1;
            console.log(`[${new Date().toISOString()}] Released room ${booking.room_id} (Booking: ${booking.token})`);
        }

        await client.query('COMMIT');
        inTransaction = false;
        console.log(`[${new Date().toISOString()}] Successfully released ${released} room(s).`);

    } catch (error) {
        if (inTransaction) {
            try { await client.query('ROLLBACK'); } catch (rollbackError) {
                console.error(`[${new Date().toISOString()}] Worker rollback error:`, rollbackError);
            }
        }
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