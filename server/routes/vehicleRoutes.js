// server/routes/vehicleRoutes.js — Stage 11B Saved Vehicle Routes
'use strict';

const express = require('express');
const { requireAuth } = require('../middleware/auth');
const {
  getMyVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
} = require('../controllers/vehicleController');

const router = express.Router();

// All vehicle routes require authenticated user
router.use(requireAuth);

// GET /api/vehicles/me — List current user's saved vehicles
router.get('/me', getMyVehicles);

// POST /api/vehicles — Add new saved vehicle
router.post('/', createVehicle);

// PATCH /api/vehicles/:vehicleId — Edit saved vehicle
router.patch('/:vehicleId', updateVehicle);

// DELETE /api/vehicles/:vehicleId — Delete saved vehicle
router.delete('/:vehicleId', deleteVehicle);

module.exports = router;
