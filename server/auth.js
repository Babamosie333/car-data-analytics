// =============================================================
// auth.js  (MongoDB version)
// -------------------------------------------------------------
// Replaces the original in-memory auth store with a persistent
// MongoDB-backed implementation. The external API (register,
// validate, getFavorites, toggleFavorite) is unchanged so that
// server.js needs no edits beyond the one-time await connect().
//
// Collection: users
// Document schema:
// {
//   _id:          ObjectId,
//   username:     string  (unique index),
//   passwordHash: string  (bcrypt),
//   favorites:    { [vehicleId: string]: vehicleSnapshot }
// }
//
// Favorites are stored as a map inside the user document so that
// toggling a single favourite is an atomic $set / $unset rather
// than a full document replacement.
// =============================================================

const bcrypt  = require('bcryptjs');
const { getDb } = require('./db');

const SALT_ROUNDS = 10;
const COL = 'users';          // collection name

// ------------------------------------------------------------------
// Internal helpers
// ------------------------------------------------------------------

function col() {
  return getDb().collection(COL);
}

// ------------------------------------------------------------------
// Public API  (all functions are now async)
// ------------------------------------------------------------------

/**
 * Registers a new user.
 * Returns true on success, false if the username is already taken.
 */
async function register(username, password) {
  const passwordHash = bcrypt.hashSync(password, SALT_ROUNDS);
  try {
    await col().insertOne({ username, passwordHash, favorites: {} });
    return true;
  } catch (err) {
    // E11000 = duplicate key (unique index on username)
    if (err.code === 11000) return false;
    throw err;
  }
}

/**
 * Validates credentials.
 * Returns true if the password matches the stored bcrypt hash.
 */
async function validate(username, password) {
  const user = await col().findOne({ username }, { projection: { passwordHash: 1 } });
  if (!user) return false;
  return bcrypt.compareSync(password, user.passwordHash);
}

/**
 * Returns the array of favorited vehicle snapshots for a user.
 */
async function getFavorites(username) {
  const user = await col().findOne({ username }, { projection: { favorites: 1 } });
  if (!user || !user.favorites) return [];
  return Object.values(user.favorites);
}

/**
 * Toggles a vehicle snapshot in the user's favorites.
 * Stores / removes the snapshot under the key favorites.<vehicleId>.
 * Returns the updated array of vehicle snapshots.
 */
async function toggleFavorite(username, vehicle) {
  if (!vehicle || !vehicle.id) return getFavorites(username);

  // Use dot-notation key: favorites.<vehicleId>
  const key = `favorites.${vehicle.id}`;

  // Check if it already exists
  const user = await col().findOne(
    { username },
    { projection: { [`favorites.${vehicle.id}`]: 1 } }
  );

  if (!user) return [];

  const exists = user.favorites && user.favorites[vehicle.id];

  if (exists) {
    // Remove it
    await col().updateOne({ username }, { $unset: { [key]: '' } });
  } else {
    // Add the full snapshot
    await col().updateOne({ username }, { $set: { [key]: vehicle } });
  }

  return getFavorites(username);
}

module.exports = { register, validate, getFavorites, toggleFavorite };
