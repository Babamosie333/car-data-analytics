// =============================================================
// sessionStore.js
// -------------------------------------------------------------
// Thin wrapper that creates a connect-mongo session store using
// the already-open MongoClient from db.js, so we don't open a
// second connection just for sessions.
//
// Usage (in server.js):
//   const { buildSessionStore } = require('./sessionStore');
//   app.use(session({ ..., store: buildSessionStore() }));
// =============================================================

const MongoStore  = require('connect-mongo');
const { getClient } = require('./db');   // we'll export client too

/**
 * Returns a MongoStore instance that reuses the existing
 * MongoDB connection opened by db.connect().
 *
 * Must be called AFTER db.connect() has resolved.
 */
function buildSessionStore() {
  return MongoStore.create({
    clientPromise:  Promise.resolve(getClient()),
    collectionName: 'sessions',
    ttl:            4 * 60 * 60,  // 4 hours (matches cookie maxAge)
    autoRemove:     'native',
  });
}

module.exports = { buildSessionStore };
