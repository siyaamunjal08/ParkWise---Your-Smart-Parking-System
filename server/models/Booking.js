// server/models/Booking.js — Booking model definition
'use strict';

const mongoose = require('mongoose');

const BookingSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User reference is required'],
      index: true,
    },
    location: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ParkingLocation',
      required: [true, 'Location reference is required'],
      index: true,
    },
    slot: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ParkingSlot',
      required: [true, 'Slot reference is required'],
    },
    // Immutable snapshots: preserve booking integrity even if slot/location/vehicle details later change
    vehicle: {
      registrationNumber: {
        type: String,
        required: [true, 'Vehicle registration number snapshot is required'],
        trim: true,
        uppercase: true,
      },
      type: {
        type: String,
        required: [true, 'Vehicle type snapshot is required'],
        enum: {
          values: ['car', 'bike', 'ev'],
          message: 'Vehicle type snapshot must be one of: car, bike, ev',
        },
      },
      label: {
        type: String,
        trim: true,
        default: '',
      },
    },
    locationName: {
      type: String,
      required: [true, 'Location name snapshot is required'],
      trim: true,
    },
    slotCode: {
      type: String,
      required: [true, 'Slot code snapshot is required'],
      trim: true,
      uppercase: true,
    },
    pricePerHourPaise: {
      type: Number,
      required: [true, 'Price snapshot is required'],
      min: [0, 'Price cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Price must be an integer number of paise',
      },
    },
    startTime: {
      type: Date,
      required: [true, 'Start time is required'],
    },
    endTime: {
      type: Date,
      required: [true, 'End time is required'],
      validate: {
        validator: function (val) {
          return !this.startTime || val > this.startTime;
        },
        message: 'End time must be later than start time',
      },
    },
    durationHours: {
      type: Number,
      required: [true, 'Duration in hours is required'],
      min: [1, 'Duration must be at least 1 hour'],
      validate: {
        validator: Number.isInteger,
        message: 'Duration hours must be an integer',
      },
    },
    totalPaise: {
      type: Number,
      required: [true, 'Total amount in paise is required'],
      min: [0, 'Total paise cannot be negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Total paise must be an integer number of paise',
      },
    },
    status: {
      type: String,
      required: [true, 'Booking status is required'],
      enum: {
        values: ['active', 'completed', 'cancelled'],
        message: 'Booking status must be one of: active, completed, cancelled',
      },
      default: 'active',
      index: true,
    },
    requestId: {
      type: String,
      required: [true, 'Idempotency request ID is required'],
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes
// 1. Partial unique index: Exactly ONE active booking per slot at any time
BookingSchema.index(
  { slot: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
  }
);

// 2. Compound unique index: Idempotency per user and requestId
BookingSchema.index({ user: 1, requestId: 1 }, { unique: true });

const Booking = mongoose.models.Booking || mongoose.model('Booking', BookingSchema);

module.exports = Booking;
