// server/models/ParkingLocation.js — ParkingLocation model definition
'use strict';

const mongoose = require('mongoose');

const ParkingLocationSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: [true, 'Location slug is required'],
      trim: true,
      lowercase: true,
      match: [/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Slug must be lower-case alphanumeric separated by single hyphens'],
    },
    name: {
      type: String,
      required: [true, 'Location name is required'],
      trim: true,
      maxlength: [150, 'Location name cannot exceed 150 characters'],
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      enum: {
        values: ['mall', 'hospital', 'office', 'other'],
        message: 'Category must be one of: mall, hospital, office, other',
      },
    },
    address: {
      type: String,
      required: function () {
        return this.status !== 'draft';
      },
      trim: true,
      maxlength: [300, 'Address cannot exceed 300 characters'],
    },
    city: {
      type: String,
      required: function () {
        return this.status !== 'draft';
      },
      trim: true,
      maxlength: [100, 'City cannot exceed 100 characters'],
    },
    area: {
      type: String,
      required: function () {
        return this.status !== 'draft';
      },
      trim: true,
      maxlength: [100, 'Area cannot exceed 100 characters'],
    },
    contactPhone: {
      type: String,
      trim: true,
      validate: {
        validator: function (val) {
          if (!val) return true;
          return /^[0-9+\-\s()]{7,20}$/.test(val);
        },
        message: 'Invalid contact phone format',
      },
    },
    latitude: {
      type: Number,
      required: function () {
        return this.status !== 'draft';
      },
      validate: {
        validator: function (val) {
          if (val === undefined || val === null) {
            return this.status === 'draft';
          }
          return Number.isFinite(val) && val >= -90 && val <= 90;
        },
        message: 'Latitude must be a finite number between -90 and +90 degrees (inclusive)',
      },
    },
    longitude: {
      type: Number,
      required: function () {
        return this.status !== 'draft';
      },
      validate: {
        validator: function (val) {
          if (val === undefined || val === null) {
            return this.status === 'draft';
          }
          return Number.isFinite(val) && val >= -180 && val <= 180;
        },
        message: 'Longitude must be a finite number between -180 and +180 degrees (inclusive)',
      },
    },
    facilities: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: {
        values: ['draft', 'active', 'closed', 'archived'],
        message: 'Status must be one of: draft, active, closed, archived',
      },
      default: 'active',
    },
    bookingRevision: {
      type: Number,
      default: 0,
      min: [0, 'Booking revision must be non-negative'],
      validate: {
        validator: Number.isInteger,
        message: 'Booking revision must be an integer',
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // Demo locations and system-seeded entries may have no human creator
    },
    isDemo: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Unique index on location slug
ParkingLocationSchema.index({ slug: 1 }, { unique: true });

const ParkingLocation = mongoose.models.ParkingLocation || mongoose.model('ParkingLocation', ParkingLocationSchema);

module.exports = ParkingLocation;
