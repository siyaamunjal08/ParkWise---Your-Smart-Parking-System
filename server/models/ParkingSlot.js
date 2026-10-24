// server/models/ParkingSlot.js — ParkingSlot model definition
'use strict';

const mongoose = require('mongoose');

const ParkingSlotSchema = new mongoose.Schema(
  {
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ParkingLocation',
      required: [true, 'Parking location reference is required'],
      index: true,
    },
    code: {
      type: String,
      required: [true, 'Slot code is required'],
      trim: true,
      uppercase: true,
      maxlength: [20, 'Slot code cannot exceed 20 characters'],
    },
    zone: {
      type: String,
      required: [true, 'Zone is required'],
      trim: true,
      uppercase: true,
      maxlength: [10, 'Zone cannot exceed 10 characters'],
    },
    floor: {
      type: Number,
      required: [true, 'Floor number is required'],
      validate: {
        validator: Number.isInteger,
        message: 'Floor must be an integer (e.g. 0 for ground, 1 for first floor)',
      },
    },
    vehicleType: {
      type: String,
      required: [true, 'Vehicle type is required'],
      enum: {
        values: ['car', 'bike', 'ev'],
        message: 'Vehicle type must be one of: car, bike, ev',
      },
    },
    pricePerHourPaise: {
      type: Number,
      required: [true, 'Price per hour in paise is required'],
      min: [0, 'Price per hour cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Price per hour must be an integer number of paise',
      },
    },
    distanceFromEntry: {
      type: Number,
      required: [true, 'Distance from entry is required'],
      min: [0, 'Distance from entry cannot be negative'],
    },
    features: {
      type: [String],
      default: [],
    },
    serviceStatus: {
      type: String,
      enum: {
        values: ['enabled', 'maintenance', 'archived'],
        message: 'Service status must be one of: enabled, maintenance, archived',
      },
      default: 'enabled',
    },
    activeBooking: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Booking',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: Each location cannot have duplicate slot codes,
// but two distinct locations CAN share the exact same slot code (e.g. A-01).
ParkingSlotSchema.index({ location: 1, code: 1 }, { unique: true });

const ParkingSlot = mongoose.models.ParkingSlot || mongoose.model('ParkingSlot', ParkingSlotSchema);

module.exports = ParkingSlot;
