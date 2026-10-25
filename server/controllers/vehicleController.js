// server/controllers/vehicleController.js — Stage 11B Saved Vehicle Controller
'use strict';

const mongoose = require('mongoose');
const { Vehicle } = require('../models');

// ── Constants & Whitelists ──────────────────────────────────────────────────

const ALLOWED_VEHICLE_TYPES = new Set(['car', 'bike', 'ev']);
const ALLOWED_CREATE_FIELDS = new Set(['label', 'registrationNumber', 'type']);
const ALLOWED_UPDATE_FIELDS = new Set(['label', 'registrationNumber', 'type']);
const FORBIDDEN_FIELDS = new Set(['owner', '_id', 'id', 'createdAt', 'updatedAt', '__v', 'role', 'user']);

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Vehicle registration number normalization:
 *   - Trim whitespace, collapse internal runs of spaces to single space,
 *   - Uppercase all characters.
 * Consistent with bookingService.normalizeVehicleNumber.
 */
function normalizeVehicleNumber(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/**
 * Sanitize Vehicle Document to DTO.
 * Excludes internal database details and owner ID.
 */
function sanitizeVehicleDto(v) {
  return {
    id: v._id.toString(),
    label: v.label || '',
    registrationNumber: v.registrationNumber,
    type: v.type,
    createdAt: v.createdAt ? v.createdAt.toISOString() : undefined,
    updatedAt: v.updatedAt ? v.updatedAt.toISOString() : undefined,
  };
}

// ── Endpoints ───────────────────────────────────────────────────────────────

/**
 * GET /api/vehicles/me
 * List all saved vehicles for the authenticated user.
 * Strictly scoped to req.user._id (even for admins).
 */
async function getMyVehicles(req, res) {
  try {
    const ownerId = req.user._id;
    const vehicles = await Vehicle.find({ owner: ownerId }).sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      vehicles: vehicles.map(sanitizeVehicleDto),
      total: vehicles.length,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to retrieve saved vehicles.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * POST /api/vehicles
 * Save a new vehicle for the authenticated user.
 * Accepts: { label?, registrationNumber, type }
 * Strictly rejects unexpected, forbidden, or privileged fields.
 */
async function createVehicle(req, res) {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    const bodyKeys = Object.keys(req.body);
    const hasForbidden = bodyKeys.filter((k) => FORBIDDEN_FIELDS.has(k) || !ALLOWED_CREATE_FIELDS.has(k));
    if (hasForbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Request contains invalid or forbidden fields: ${hasForbidden.join(', ')}.`,
        code: 'FORBIDDEN_FIELDS',
      });
    }

    const { label, registrationNumber, type } = req.body;

    // Validate registration number
    if (!registrationNumber || typeof registrationNumber !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Registration number is required.',
        code: 'MISSING_FIELD',
      });
    }

    const normalizedReg = normalizeVehicleNumber(registrationNumber);
    if (normalizedReg.length < 2 || normalizedReg.length > 20) {
      return res.status(400).json({
        success: false,
        message: 'Registration number must be between 2 and 20 characters.',
        code: 'INVALID_REGISTRATION_NUMBER',
      });
    }

    // Validate vehicle type
    if (!type || typeof type !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Vehicle type is required.',
        code: 'MISSING_FIELD',
      });
    }

    const normalizedType = type.toLowerCase().trim();
    if (!ALLOWED_VEHICLE_TYPES.has(normalizedType)) {
      return res.status(400).json({
        success: false,
        message: 'Vehicle type must be one of: car, bike, ev.',
        code: 'INVALID_VEHICLE_TYPE',
      });
    }

    // Validate optional label
    let cleanLabel = '';
    if (label !== undefined && label !== null) {
      if (typeof label !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Label must be a string.',
          code: 'INVALID_LABEL',
        });
      }
      cleanLabel = label.trim();
      if (cleanLabel.length > 50) {
        return res.status(400).json({
          success: false,
          message: 'Label cannot exceed 50 characters.',
          code: 'INVALID_LABEL',
        });
      }
    }

    // Pre-check duplicate registration number for this user
    const existing = await Vehicle.findOne({ owner: req.user._id, registrationNumber: normalizedReg });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `You have already saved a vehicle with registration number "${normalizedReg}".`,
        code: 'DUPLICATE_VEHICLE',
      });
    }

    const vehicle = await Vehicle.create({
      owner: req.user._id,
      label: cleanLabel,
      registrationNumber: normalizedReg,
      type: normalizedType,
    });

    return res.status(201).json({
      success: true,
      message: 'Vehicle saved successfully.',
      vehicle: sanitizeVehicleDto(vehicle),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You have already saved a vehicle with this registration number.',
        code: 'DUPLICATE_VEHICLE',
      });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ') || 'Vehicle validation failed.',
        code: 'VALIDATION_ERROR',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to save vehicle.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * PATCH /api/vehicles/:vehicleId
 * Update an existing saved vehicle.
 * Strictly owner-scoped (returns 404 if vehicle does not exist or belongs to another user).
 */
async function updateVehicle(req, res) {
  try {
    const { vehicleId } = req.params;
    if (!vehicleId || !mongoose.isValidObjectId(vehicleId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid vehicle ID format.',
        code: 'INVALID_ID',
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        success: false,
        message: 'Request body must be a valid JSON object.',
        code: 'INVALID_BODY',
      });
    }

    const bodyKeys = Object.keys(req.body);
    if (bodyKeys.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one field to update must be provided.',
        code: 'EMPTY_UPDATE',
      });
    }

    const forbidden = bodyKeys.filter((k) => FORBIDDEN_FIELDS.has(k) || !ALLOWED_UPDATE_FIELDS.has(k));
    if (forbidden.length > 0) {
      return res.status(400).json({
        success: false,
        message: `Request contains invalid or forbidden fields: ${forbidden.join(', ')}.`,
        code: 'FORBIDDEN_FIELDS',
      });
    }

    // Lookup vehicle scoped strictly to authenticated owner
    const vehicle = await Vehicle.findOne({ _id: vehicleId, owner: req.user._id });
    if (!vehicle) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found.',
        code: 'VEHICLE_NOT_FOUND',
      });
    }

    const updates = {};

    // Validate registration number if provided
    if (req.body.registrationNumber !== undefined) {
      if (typeof req.body.registrationNumber !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Registration number must be a string.',
          code: 'INVALID_REGISTRATION_NUMBER',
        });
      }
      const normalizedReg = normalizeVehicleNumber(req.body.registrationNumber);
      if (normalizedReg.length < 2 || normalizedReg.length > 20) {
        return res.status(400).json({
          success: false,
          message: 'Registration number must be between 2 and 20 characters.',
          code: 'INVALID_REGISTRATION_NUMBER',
        });
      }

      // Check duplicate against other vehicles owned by this user
      if (normalizedReg !== vehicle.registrationNumber) {
        const conflict = await Vehicle.findOne({
          owner: req.user._id,
          registrationNumber: normalizedReg,
          _id: { $ne: vehicleId },
        });
        if (conflict) {
          return res.status(409).json({
            success: false,
            message: `You have already saved a vehicle with registration number "${normalizedReg}".`,
            code: 'DUPLICATE_VEHICLE',
          });
        }
      }
      updates.registrationNumber = normalizedReg;
    }

    // Validate vehicle type if provided
    if (req.body.type !== undefined) {
      if (typeof req.body.type !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Vehicle type must be a string.',
          code: 'INVALID_VEHICLE_TYPE',
        });
      }
      const normalizedType = req.body.type.toLowerCase().trim();
      if (!ALLOWED_VEHICLE_TYPES.has(normalizedType)) {
        return res.status(400).json({
          success: false,
          message: 'Vehicle type must be one of: car, bike, ev.',
          code: 'INVALID_VEHICLE_TYPE',
        });
      }
      updates.type = normalizedType;
    }

    // Validate label if provided
    if (req.body.label !== undefined) {
      if (typeof req.body.label !== 'string') {
        return res.status(400).json({
          success: false,
          message: 'Label must be a string.',
          code: 'INVALID_LABEL',
        });
      }
      const cleanLabel = req.body.label.trim();
      if (cleanLabel.length > 50) {
        return res.status(400).json({
          success: false,
          message: 'Label cannot exceed 50 characters.',
          code: 'INVALID_LABEL',
        });
      }
      updates.label = cleanLabel;
    }

    // Apply updates
    Object.assign(vehicle, updates);
    await vehicle.save();

    return res.status(200).json({
      success: true,
      message: 'Vehicle updated successfully.',
      vehicle: sanitizeVehicleDto(vehicle),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        success: false,
        message: 'You have already saved a vehicle with this registration number.',
        code: 'DUPLICATE_VEHICLE',
      });
    }
    if (err.name === 'ValidationError') {
      const messages = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: messages.join(', ') || 'Vehicle validation failed.',
        code: 'VALIDATION_ERROR',
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Failed to update vehicle.',
      code: 'INTERNAL_ERROR',
    });
  }
}

/**
 * DELETE /api/vehicles/:vehicleId
 * Delete a saved vehicle.
 * Strictly owner-scoped (returns 404 if not found or belongs to another user).
 * Past bookings remain completely unchanged.
 */
async function deleteVehicle(req, res) {
  try {
    const { vehicleId } = req.params;
    if (!vehicleId || !mongoose.isValidObjectId(vehicleId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid vehicle ID format.',
        code: 'INVALID_ID',
      });
    }

    const deleted = await Vehicle.findOneAndDelete({ _id: vehicleId, owner: req.user._id });
    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Vehicle not found.',
        code: 'VEHICLE_NOT_FOUND',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Vehicle deleted successfully.',
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: 'Failed to delete vehicle.',
      code: 'INTERNAL_ERROR',
    });
  }
}

module.exports = {
  getMyVehicles,
  createVehicle,
  updateVehicle,
  deleteVehicle,
  normalizeVehicleNumber,
  sanitizeVehicleDto,
};
