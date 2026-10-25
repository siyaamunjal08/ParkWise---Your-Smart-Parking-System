// server/routes/locationRoutes.js — Public location & slot routes (Stage 5 + Stage 6)
'use strict';

const express = require('express');
const router = express.Router();

const {
  listPublicLocations,
  getPublicLocation,
  getPublicSlots,
} = require('../controllers/locationController');

const { getSlotRecommendations } = require('../controllers/bookingController');

// GET /api/locations?q=&city=&area=&page=&limit=
router.get('/', listPublicLocations);

// GET /api/locations/:locationId
router.get('/:locationId', getPublicLocation);

// GET /api/locations/:locationId/slots
router.get('/:locationId/slots', getPublicSlots);

// GET /api/locations/:locationId/recommendations — Stage 6
router.get('/:locationId/recommendations', getSlotRecommendations);

module.exports = router;
