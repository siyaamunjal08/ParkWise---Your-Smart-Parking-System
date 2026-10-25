// server/server.js — HTTP listener, database initialization & lifecycle management

'use strict';

require('dotenv').config();

const http = require('http');
const app  = require('./app');
const { connectDB, disconnectDB } = require('./config/db');
const { startExpirySweeper, stopExpirySweeper, reconcileExpired } = require('./services/bookingService');

const PORT = parseInt(process.env.PORT, 10) || 5000;
const server = http.createServer(app);

// ── Error Handling (e.g., EADDRINUSE) ────────────────────────
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Server Fatal] Port ${PORT} is already in use by another process.`);
    console.error(`[Server Fatal] Please stop the process using port ${PORT} or specify a different PORT in .env.`);
  } else {
    console.error('[Server Fatal] Unexpected server error:', err.message);
  }
  process.exit(1);
});

// ── Graceful Shutdown ────────────────────────────────────────
const handleShutdown = async (signal) => {
  console.log(`\n[Server] ${signal} signal received. Closing HTTP server and database connection gracefully.`);

  // Stop the expiry sweeper before closing the DB connection
  stopExpirySweeper();

  server.close(async () => {
    console.log('[Server] HTTP server closed cleanly.');
    try {
      await disconnectDB();
      console.log('[Server] Database connection closed cleanly.');
    } catch (dbErr) {
      console.error('[Server Error] Error closing database connection:', dbErr.message);
    }
    process.exit(0);
  });
};

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT',  () => handleShutdown('SIGINT'));

// ── Start Server & Connect Database ──────────────────────────
(async () => {
  try {
    await connectDB();
  } catch (err) {
    const sanitizedError = (err.message || 'Connection error').replace(/mongodb(?:\+srv)?:\/\/[^@]+@/gi, 'mongodb+srv://***:***@');
    console.error(`[Database Warning] Startup connection failed: ${sanitizedError}`);
    console.error('[Database Warning] HTTP server will still start, but /api/ready will report 503.');
  }

  // Run startup expiry reconciliation (clear any bookings that expired while server was down)
  try {
    const { totalProcessed } = await reconcileExpired();
    if (totalProcessed > 0) {
      console.log(`[BookingService] Startup reconciliation: completed ${totalProcessed} expired booking(s).`);
    }
  } catch (reconcileErr) {
    console.error('[BookingService] Startup reconciliation error:', reconcileErr.message);
  }

  // Start the 30-second periodic expiry sweeper
  startExpirySweeper();

  server.listen(PORT, () => {
    console.log(`[Server] ParkWise server listening on http://localhost:${PORT}`);
    console.log(`[Server] Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`[Server] Frontend served from: public/`);
    console.log(`[Server] Health check: http://localhost:${PORT}/api/health`);
    console.log(`[Server] Readiness check: http://localhost:${PORT}/api/ready`);
  });
})();

module.exports = server;
