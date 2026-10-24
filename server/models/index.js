// server/models/index.js — Unified model exports
'use strict';

const User = require('./User');
const ParkingLocation = require('./ParkingLocation');
const ParkingSlot = require('./ParkingSlot');
const Booking = require('./Booking');
const Vehicle = require('./Vehicle');

module.exports = {
  User,
  ParkingLocation,
  ParkingSlot,
  Booking,
  Vehicle,
};
