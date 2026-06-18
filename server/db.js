// =============================================================
// db.js
// -------------------------------------------------------------
// MongoDB connection using the native driver (no Mongoose).
// Exports a connect() function and a getDb() helper used by
// auth.js, sessionStore.js, and server.js.
//
// Connection string is read from the MONGODB_URI environment
// variable (set it in a .env file or your hosting panel).
// Falls back to a local default for development.
//
// Usage:
//   const { connect, getDb } = require('./db');
//   await connect();                     // call once at startup
//   const db = getDb();                  // anywhere after connect
//   await db.collection('users').find(); // use normally
// =============================================================

const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DB_NAME     = process.env.DB_NAME     || 'car_analytics';

// ---------------------------------------------------------------
// Serverless-safe connection caching.
// -----------------------------------------------------------------
// On Vercel, each request can hit a fresh (or recycled) function
// instance, and the whole module can be re-evaluated. We cache the
// connection promise on `global` so that warm invocations reuse the
// same MongoClient instead of opening a new connection every time,
// which would otherwise quickly exhaust Atlas's free-tier
// connection limit. This is the standard pattern recommended for
// using MongoDB in serverless environments.
// ---------------------------------------------------------------
let client = null;
let db     = null;

async function connect() {
  if (db) return db;

  if (!global._mongoClientPromise) {
    const newClient = new MongoClient(MONGODB_URI, {
      serverSelectionTimeoutMS: 10_000,
    });
    global._mongoClientPromise = newClient.connect().then(async (connectedClient) => {
      const connectedDb = connectedClient.db(DB_NAME);
      // Ensure the username field is unique (safe to call repeatedly)
      await connectedDb.collection('users').createIndex({ username: 1 }, { unique: true });
      return { client: connectedClient, db: connectedDb };
    });
  }

  const resolved = await global._mongoClientPromise;
  client = resolved.client;
  db     = resolved.db;

  console.log(`[MongoDB] Connected to "${DB_NAME}"`);
  return db;
}

/**
 * Returns the active Db instance.
 * Throws if connect() has not been called yet.
 */
function getDb() {
  if (!db) throw new Error('MongoDB not connected - call connect() first');
  return db;
}

/**
 * Returns the active MongoClient instance.
 * Throws if connect() has not been called yet.
 */
function getClient() {
  if (!client) throw new Error('MongoDB not connected - call connect() first');
  return client;
}

/**
 * Graceful shutdown helper (optional - useful in tests).
 */
async function close() {
  if (client) {
    await client.close();
    client = null;
    db     = null;
    console.log('[MongoDB] Connection closed');
  }
}

module.exports = { connect, getDb, getClient, close };
