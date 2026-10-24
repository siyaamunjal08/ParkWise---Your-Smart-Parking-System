// server/models/Vehicle.js — Vehicle model definition
'use strict';

const mongoose = require('mongoose');

const VehicleSchema = new mongoose.Schema(
  {
    owner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Vehicle owner reference is required'],
      index: true,
    },
    label: {
      type: String,
      trim: true,
      maxlength: [50, 'Label cannot exceed 50 characters'],
      default: '',
    },
    registrationNumber: {
      type: String,
      required: [true, 'Registration number is required'],
      trim: true,
      uppercase: true,
      maxlength: [20, 'Registration number cannot exceed 20 characters'],
    },
    type: {
      type: String,
      required: [true, 'Vehicle type is required'],
      enum: {
        values: ['car', 'bike', 'ev'],
        message: 'Vehicle type must be one of: car, bike, ev',
      },
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: A user cannot add duplicate registration numbers,
// but two different users can track their own vehicles
VehicleSchema.index({ owner: 1, registrationNumber: 1 }, { unique: true });

const Vehicle = mongoose.models.Vehicle || mongoose.model('Vehicle', VehicleSchema);

module.exports = Vehicle;
