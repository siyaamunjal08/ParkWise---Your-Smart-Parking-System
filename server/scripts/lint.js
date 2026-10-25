// server/scripts/lint.js — Check JavaScript syntax across all project files
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const files = [
  'server/app.js',
  'server/server.js',
  'server/config/env.js',
  'server/config/db.js',
  'server/utils/authUtils.js',
  'server/middleware/auth.js',
  'server/middleware/rateLimiter.js',
  'server/controllers/authController.js',
  'server/controllers/locationController.js',
  'server/controllers/bookingController.js',
  'server/controllers/vehicleController.js',
  'server/routes/authRoutes.js',
  'server/routes/locationRoutes.js',
  'server/routes/adminRoutes.js',
  'server/routes/bookingRoutes.js',
  'server/routes/vehicleRoutes.js',
  'server/services/bookingService.js',
  'server/scripts/checkDb.js',
  'server/scripts/seedDemo.js',
  'server/scripts/createAdmin.js',
  'server/scripts/lint.js',
  'server/models/User.js',
  'server/models/ParkingLocation.js',
  'server/models/ParkingSlot.js',
  'server/models/Booking.js',
  'server/models/Vehicle.js',
  'server/models/index.js',
  'tests/foundation.test.js',
  'tests/db.test.js',
  'tests/auth.test.js',
  'tests/integration.test.js',
  'tests/locations.test.js',
  'tests/bookings.test.js',
  'tests/apiClient.test.js',
  'tests/locationsFrontend.test.js',
  'tests/bookingFrontend.test.js',
  'tests/adminFrontend.test.js',
  'tests/stage11a.test.js',
  'tests/stage11b.test.js',
  'public/js/api.js',
  'public/js/storage.js',
  'public/js/auth.js',
  'public/js/login.js',
  'public/js/register.js',
  'public/js/dashboard.js',
  'public/js/booking.js',
  'public/js/history.js',
  'public/js/locations.js',
  'public/js/admin.js',
  'public/js/index.js',
];

const rootDir = path.resolve(__dirname, '../..');
let hasError = false;

for (const file of files) {
  const filePath = path.join(rootDir, file);
  try {
    execFileSync(process.execPath, ['--check', filePath], { stdio: 'pipe' });
  } catch (err) {
    console.error(`Syntax error in ${file}:\n`, err.stderr ? err.stderr.toString() : err.message);
    hasError = true;
  }
}

if (hasError) {
  process.exit(1);
}

console.log(`✅ All ${files.length} files passed syntax lint check.`);
