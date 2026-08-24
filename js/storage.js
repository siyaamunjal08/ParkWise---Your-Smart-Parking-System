// Storage Module - Arpit

/* ============================================================
   js/storage.js
   Smart Parking System — Storage Adapter (Mock MongoDB Layer)

   PURPOSE:
   Abstracts all localStorage / sessionStorage access behind a
   clean API that mirrors MongoDB collection operations.

   COLLECTIONS:
   - sps_users     → registered user documents
   - sps_bookings  → booking records
   - sps_slots     → parking slot states

   SESSION:
   - sps_session   → current logged-in user (sessionStorage)
   ============================================================ */

'use strict';

// ─── Collection Key Constants ────────────────────────────────
const COLLECTIONS = Object.freeze({
  USERS:    'sps_users',
  BOOKINGS: 'sps_bookings',
  SLOTS:    'sps_slots',
});

const SESSION_KEY = 'sps_session';

// ─── ID Generator ─────────────────────────────────────────────
/**
 * Generates a unique document ID.
 * @returns {string}
 */
const generateId = () => {
  const timestamp = Date.now().toString(36);
  const random    = Math.random().toString(36).slice(2, 9);
  return `${timestamp}${random}`;
};

// ─── Core Storage Service ──────────────────────────────────────
/**
 * Generic CRUD adapter over localStorage.
 * All domain stores (UserStore, BookingStore, SlotStore) are
 * built on top of this — they never touch localStorage directly.
 */
const StorageService = (() => {

  /**
   * Read all documents from a collection.
   * @param {string} collection
   * @returns {Array}
   */
  const getAll = (collection) => {
    try {
      const raw = localStorage.getItem(collection);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  };

  /**
   * Overwrite an entire collection.
   * Internal use only — domain stores call this via mutations.
   * @param {string} collection
   * @param {Array}  docs
   * @returns {boolean}
   */
  const setAll = (collection, docs) => {
    try {
      localStorage.setItem(collection, JSON.stringify(docs));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Find documents matching every key/value pair in the filter.
   * @param {string} collection
   * @param {Object} filter
   * @returns {Array}
   */
  const find = (collection, filter = {}) => {
    const docs = getAll(collection);
    const keys = Object.keys(filter);
    if (keys.length === 0) return docs;
    return docs.filter(doc =>
      keys.every(key => doc[key] === filter[key])
    );
  };

  /**
   * Find the first document matching the filter.
   * @param {string} collection
   * @param {Object} filter
   * @returns {Object|null}
   */
  const findOne = (collection, filter = {}) => {
    return find(collection, filter)[0] ?? null;
  };

  /**
   * Find a document by its _id field.
   * @param {string} collection
   * @param {string} id
   * @returns {Object|null}
   */
  const findById = (collection, id) => {
    return findOne(collection, { _id: id });
  };

  /**
   * Insert a new document. Auto-attaches _id and timestamps.
   * @param {string} collection
   * @param {Object} doc
   * @returns {Object} the saved document with _id
   */
  const insertOne = (collection, doc) => {
    const docs   = getAll(collection);
    const now    = new Date().toISOString();
    const newDoc = {
      _id:       generateId(),
      createdAt: now,
      updatedAt: now,
      ...doc,
    };
    docs.push(newDoc);
    setAll(collection, docs);
    return newDoc;
  };

  /**
   * Update a document by _id. Merges fields — never overwrites _id.
   * @param {string} collection
   * @param {string} id
   * @param {Object} updates
   * @returns {Object|null} the updated document
   */
  const updateById = (collection, id, updates) => {
    const docs  = getAll(collection);
    const index = docs.findIndex(doc => doc._id === id);
    if (index === -1) return null;

    docs[index] = {
      ...docs[index],
      ...updates,
      _id:       docs[index]._id,       // _id is immutable
      createdAt: docs[index].createdAt, // createdAt is immutable
      updatedAt: new Date().toISOString(),
    };

    setAll(collection, docs);
    return docs[index];
  };

  /**
   * Delete a document by its _id.
   * @param {string} collection
   * @param {string} id
   * @returns {boolean} true if deleted, false if not found
   */
  const deleteById = (collection, id) => {
    const docs     = getAll(collection);
    const filtered = docs.filter(doc => doc._id !== id);
    if (filtered.length === docs.length) return false;
    setAll(collection, filtered);
    return true;
  };

  /**
   * Count documents matching an optional filter.
   * @param {string} collection
   * @param {Object} filter
   * @returns {number}
   */
  const count = (collection, filter = {}) => {
    return find(collection, filter).length;
  };

  /**
   * Drop all documents from a collection.
   * @param {string} collection
   */
  const drop = (collection) => {
    localStorage.removeItem(collection);
  };

  // Expose only the public interface
  return Object.freeze({
    getAll,
    setAll,
    findById,
    find,
    findOne,
    insertOne,
    updateById,
    deleteById,
    count,
    drop,
  });

})();


// ─── User Store ────────────────────────────────────────────────
/**
 * All user-related persistence operations.
 * Wraps StorageService with user-specific semantics.
 *
 * Document shape:
 * {
 *   _id          : string
 *   name         : string
 *   email        : string  (lowercase, trimmed)
 *   phone        : string
 *   passwordHash : string
 *   createdAt    : ISO string
 *   updatedAt    : ISO string
 * }
 */
const UserStore = Object.freeze({

  /**
   * Save a new user to the users collection.
   * @param {{ name, email, phone, passwordHash }} userData
   * @returns {Object} saved user document
   */
  create: (userData) => {
    const normalised = {
      ...userData,
      email: userData.email.toLowerCase().trim(),
    };
    return StorageService.insertOne(COLLECTIONS.USERS, normalised);
  },

  /**
   * Find a user by email address.
   * @param {string} email
   * @returns {Object|null}
   */
  findByEmail: (email) => {
    return StorageService.findOne(
      COLLECTIONS.USERS,
      { email: email.toLowerCase().trim() }
    );
  },

  /**
   * Find a user by their _id.
   * @param {string} id
   * @returns {Object|null}
   */
  findById: (id) => {
    return StorageService.findById(COLLECTIONS.USERS, id);
  },

  /**
   * Update a user's profile fields.
   * @param {string} id
   * @param {Object} updates
   * @returns {Object|null}
   */
  update: (id, updates) => {
    return StorageService.updateById(COLLECTIONS.USERS, id, updates);
  },

  /**
   * Check whether an email address is already registered.
   * @param {string} email
   * @returns {boolean}
   */
  emailExists: (email) => {
    return UserStore.findByEmail(email) !== null;
  },

});


// ─── Booking Store ─────────────────────────────────────────────
/**
 * All booking-related persistence operations.
 *
 * Document shape:
 * {
 *   _id           : string
 *   userId        : string
 *   slotId        : string   (e.g. "A-01")
 *   zone          : string   ("A" | "B" | "C")
 *   vehicleNumber : string
 *   vehicleType   : string   ("car" | "bike" | "ev")
 *   startTime     : ISO string
 *   durationHours : number
 *   totalCost     : number
 *   status        : "active" | "completed" | "cancelled"
 *   createdAt     : ISO string
 *   updatedAt     : ISO string
 *   cancelledAt?  : ISO string
 *   completedAt?  : ISO string
 * }
 */
const BookingStore = Object.freeze({

  /**
   * Create a new booking record.
   * @param {Object} bookingData
   * @returns {Object} saved booking document
   */
  create: (bookingData) => {
    return StorageService.insertOne(COLLECTIONS.BOOKINGS, {
      ...bookingData,
      status: 'active',
    });
  },

  /**
   * Get all bookings for a specific user, newest first.
   * @param {string} userId
   * @returns {Array}
   */
  findByUser: (userId) => {
    const bookings = StorageService.find(COLLECTIONS.BOOKINGS, { userId });
    return bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  /**
   * Find a booking by its _id.
   * @param {string} id
   * @returns {Object|null}
   */
  findById: (id) => {
    return StorageService.findById(COLLECTIONS.BOOKINGS, id);
  },

  /**
   * Get the active booking occupying a specific slot (if any).
   * @param {string} slotId
   * @returns {Object|null}
   */
  findActiveBySlot: (slotId) => {
    return StorageService.findOne(
      COLLECTIONS.BOOKINGS,
      { slotId, status: 'active' }
    );
  },

  /**
   * Get all active bookings for a user.
   * @param {string} userId
   * @returns {Array}
   */
  findActiveByUser: (userId) => {
    return StorageService.find(
      COLLECTIONS.BOOKINGS,
      { userId, status: 'active' }
    );
  },

  /**
   * Cancel a booking by its _id.
   * @param {string} id
   * @returns {Object|null} updated booking
   */
  cancel: (id) => {
    return StorageService.updateById(COLLECTIONS.BOOKINGS, id, {
      status:      'cancelled',
      cancelledAt: new Date().toISOString(),
    });
  },

  /**
   * Mark a booking as completed.
   * @param {string} id
   * @returns {Object|null} updated booking
   */
  complete: (id) => {
    return StorageService.updateById(COLLECTIONS.BOOKINGS, id, {
      status:      'completed',
      completedAt: new Date().toISOString(),
    });
  },

  /**
   * Count active bookings for a user.
   * @param {string} userId
   * @returns {number}
   */
  countActive: (userId) => {
    return StorageService.count(
      COLLECTIONS.BOOKINGS,
      { userId, status: 'active' }
    );
  },

});


// ─── Slot Store ────────────────────────────────────────────────
/**
 * All parking slot persistence operations.
 * On first page load, slots are seeded from parking.json.
 *
 * Document shape (mirrors parking.json slot object):
 * {
 *   _id               : string  (same as "id" from JSON)
 *   id                : string  (e.g. "A-01")
 *   zone              : string
 *   number            : number
 *   type              : "car" | "bike" | "ev"
 *   status            : "available" | "occupied" | "reserved"
 *   pricePerHour      : number
 *   floor             : string
 *   distanceFromEntry : number
 *   features          : Array<string>
 *   row               : number
 *   col               : number
 * }
 */
const SlotStore = Object.freeze({

  /**
   * Seed the slots collection from parking.json data.
   * Only runs if the collection is empty (first-time load).
   * @param {Array} slotsData - the "slots" array from parking.json
   */
  seed: (slotsData) => {
    if (StorageService.count(COLLECTIONS.SLOTS) === 0) {
      const withIds = slotsData.map(slot => ({
        _id: slot.id,   // use slot id ("A-01") as the document _id
        ...slot,
      }));
      StorageService.setAll(COLLECTIONS.SLOTS, withIds);
    }
  },

  /**
   * Get all slots.
   * @returns {Array}
   */
  getAll: () => {
    return StorageService.getAll(COLLECTIONS.SLOTS);
  },

  /**
   * Get all slots in a specific zone.
   * @param {string} zone - "A" | "B" | "C"
   * @returns {Array}
   */
  findByZone: (zone) => {
    return StorageService.find(COLLECTIONS.SLOTS, { zone });
  },

  /**
   * Get a slot by its id ("A-01", "B-05", etc.).
   * @param {string} id
   * @returns {Object|null}
   */
  findById: (id) => {
    return StorageService.findById(COLLECTIONS.SLOTS, id);
  },

  /**
   * Get all currently available slots.
   * @returns {Array}
   */
  getAvailable: () => {
    return StorageService.find(COLLECTIONS.SLOTS, { status: 'available' });
  },

  /**
   * Get available slots filtered by type.
   * @param {string} type - "car" | "bike" | "ev"
   * @returns {Array}
   */
  getAvailableByType: (type) => {
    return StorageService.find(
      COLLECTIONS.SLOTS,
      { status: 'available', type }
    );
  },

  /**
   * Mark a slot as occupied when a booking is confirmed.
   * @param {string} id
   * @returns {Object|null}
   */
  occupy: (id) => {
    return StorageService.updateById(
      COLLECTIONS.SLOTS, id, { status: 'occupied' }
    );
  },

  /**
   * Release a slot back to available when a booking is cancelled/completed.
   * @param {string} id
   * @returns {Object|null}
   */
  release: (id) => {
    return StorageService.updateById(
      COLLECTIONS.SLOTS, id, { status: 'available' }
    );
  },

  /**
   * Count available slots, with an optional filter.
   * @param {Object} filter - e.g. { zone: "A" } or { type: "ev" }
   * @returns {number}
   */
  countAvailable: (filter = {}) => {
    return StorageService.count(
      COLLECTIONS.SLOTS,
      { status: 'available', ...filter }
    );
  },

});


// ─── Session Store ─────────────────────────────────────────────
/**
 * Manages the current user's login session via sessionStorage.
 * sessionStorage is tab-scoped — session auto-clears on tab close.
 *
 * Session shape:
 * {
 *   userId  : string
 *   name    : string
 *   email   : string
 *   loginAt : ISO string
 * }
 */
const SessionStore = Object.freeze({

  /**
   * Persist a user session after successful login.
   * @param {{ _id, name, email }} user
   */
  save: (user) => {
    const session = {
      userId:  user._id,
      name:    user.name,
      email:   user.email,
      loginAt: new Date().toISOString(),
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  },

  /**
   * Read the current session object.

   * @returns {Object|null}
   */
  get: () => {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  /**
   * Check whether a user is currently logged in.
   * @returns {boolean}
   */
  isLoggedIn: () => {
    return SessionStore.get() !== null;
  },

  /**
   * Get the logged-in user's ID.
   * @returns {string|null}
   */
  getUserId: () => {
    return SessionStore.get()?.userId ?? null;
  },

  /**
   * Get the logged-in user's display name.
   * @returns {string|null}
   */
  getName: () => {
    return SessionStore.get()?.name ?? null;
  },

  /**
   * Clear the session (logout).
   */
  clear: () => {
    sessionStorage.removeItem(SESSION_KEY);
  },

});
