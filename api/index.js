// =============================================================
// api/index.js
// -------------------------------------------------------------
// Vercel serverless entry point. Vercel turns every file under
// /api into its own serverless function. Here we have a single
// catch-all function (see the rewrite rule in vercel.json) that
// forwards every request into the existing Express app, so all
// the routes defined in server/server.js keep working unchanged.
// =============================================================

module.exports = require('../server/server.js');
