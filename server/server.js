// =============================================================
// server/server.js  –  Vercel-serverless version
// =============================================================
// Changes vs. original long-running server:
//  1. No http.createServer / app.listen in production – the
//     Express app is exported so Vercel can wrap it.
//     Locally (npm run dev / npm start) app.listen still runs.
//  2. Socket.IO removed – serverless functions cannot hold a
//     persistent WebSocket. The frontend polls REST endpoints.
//  3. No setInterval refresh loop – serverless functions don't
//     stay alive between requests.  Every data-reading route
//     calls ensureFreshData() which:
//       a) loads the latest snapshot from MongoDB
//       b) regenerates it if missing or older than FETCH_INTERVAL_MS
//       c) caches in module-level vars for the warm-instance lifetime
//     Vercel Cron (vercel.json) can hit /api/refresh proactively.
//  4. Everything else (clustering, regression, auth, analytics,
//     depreciation) is functionally unchanged.
// =============================================================

require('dotenv').config(); // load .env (MONGODB_URI etc.) for local dev

const path    = require('path');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');

// ---------- MongoDB ----------
const { connect: connectDB, getDb, getClient, close } = require('./db');
const buildSessionStore      = require('./sessionStore');

const { fetchVehicleData }              = require('./api');
const { runKMeans }                     = require('./clustering');
const { trainModel, predict, computeResiduals } = require('./regression');
const auth                              = require('./auth');

const app = express();

const PORT              = process.env.PORT || 3000;
const FETCH_INTERVAL_MS = 90 * 1000;
const GOOD_DEAL_THRESHOLD   = 0.85;
const ANOMALY_STD_MULTIPLIER = 2;

// MongoDB collection names
const COL_VEHICLES = 'vehicles';

// -------------------------------------------------------------
// Module-level cache – best-effort only on serverless.
// A warm function instance may reuse this, but it is never
// assumed to be the source of truth (MongoDB always is).
// -------------------------------------------------------------
let vehicleData     = [];
let clusterResult   = { clusters: [], stats: [], k: 0 };
let priceModel      = null;
let currentK        = 3;
let depreciationData = { brands: [], series: {} };
let lastUpdated     = null;

// -------------------------------------------------------------
// Helpers / statistics
// -------------------------------------------------------------
function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr) {
  if (!arr.length) return 0;
  const mean = average(arr);
  return Math.sqrt(average(arr.map(x => (x - mean) ** 2)));
}

// -------------------------------------------------------------
// Analytics & depreciation  (unchanged)
// -------------------------------------------------------------
function computeAnalytics(data) {
  const total = data.length;
  if (!total) return { totalVehicles: 0, avgPrice: 0, avgMileage: 0, avgEngineSize: 0, fuelDistribution: {}, ageDistribution: {} };

  const sum = key => data.reduce((acc, v) => acc + v[key], 0);

  const fuelDistribution = {};
  data.forEach(v => { fuelDistribution[v.fuelType] = (fuelDistribution[v.fuelType] || 0) + 1; });

  const ageBins = { '0-2': 0, '3-5': 0, '6-10': 0, '11-15': 0, '16+': 0 };
  data.forEach(v => {
    if      (v.age < 2)  ageBins['0-2']++;
    else if (v.age < 5)  ageBins['3-5']++;
    else if (v.age < 10) ageBins['6-10']++;
    else if (v.age < 15) ageBins['11-15']++;
    else                 ageBins['16+']++;
  });

  return {
    totalVehicles:  total,
    avgPrice:       Math.round(sum('price')      / total),
    avgMileage:     Math.round(sum('mileage')    / total),
    avgEngineSize:  parseFloat((sum('engineSize') / total).toFixed(2)),
    fuelDistribution,
    ageDistribution: ageBins,
  };
}

function computeDepreciation(data, topN = 5) {
  if (!data.length) return { brands: [], series: {} };

  const counts = {};
  data.forEach(v => { counts[v.brand] = (counts[v.brand] || 0) + 1; });

  const topBrands = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(b => b[0]);

  const series = {};
  topBrands.forEach(brand => {
    const byAge = {};
    data.filter(v => v.brand === brand).forEach(v => {
      if (!byAge[v.age]) byAge[v.age] = { sum: 0, count: 0 };
      byAge[v.age].sum   += v.price;
      byAge[v.age].count++;
    });
    series[brand] = Object.keys(byAge)
      .map(Number)
      .sort((a, b) => a - b)
      .map(age => ({ age, avgPrice: Math.round(byAge[age].sum / byAge[age].count) }));
  });

  return { brands: topBrands, series };
}

// -------------------------------------------------------------
// Query validation  (unchanged)
// -------------------------------------------------------------
function parseVehicleFilters(query) {
  const { brand, fuelType, minPrice, maxPrice, minMileage, maxMileage, goodDealOnly, anomalyOnly } = query;
  for (const [key, value] of Object.entries({ minPrice, maxPrice, minMileage, maxMileage })) {
    if (value !== undefined && value !== '' && isNaN(Number(value)))
      return { error: `Query parameter ${key} must be a number` };
  }
  return { filters: { brand, fuelType, minPrice, maxPrice, minMileage, maxMileage, goodDealOnly, anomalyOnly } };
}

function applyVehicleFilters(data, filters) {
  const { brand, fuelType, minPrice, maxPrice, minMileage, maxMileage, goodDealOnly, anomalyOnly } = filters;
  let f = [...data];
  if (brand)      f = f.filter(v => v.brand.toLowerCase()    === brand.toLowerCase());
  if (fuelType)   f = f.filter(v => v.fuelType.toLowerCase() === fuelType.toLowerCase());
  if (minPrice)   f = f.filter(v => v.price   > Number(minPrice));
  if (maxPrice)   f = f.filter(v => v.price   < Number(maxPrice));
  if (minMileage) f = f.filter(v => v.mileage > Number(minMileage));
  if (maxMileage) f = f.filter(v => v.mileage < Number(maxMileage));
  if (goodDealOnly === 'true') f = f.filter(v => v.isGoodDeal);
  if (anomalyOnly  === 'true') f = f.filter(v => v.isAnomaly);
  return f;
}

// -------------------------------------------------------------
// Annotation pipeline  (unchanged)
// -------------------------------------------------------------
function annotateVehicles(rawVehicles, k) {
  const clustering  = runKMeans(rawVehicles, k);
  const residuals   = computeResiduals(priceModel, rawVehicles);
  const threshold   = stddev(residuals) * ANOMALY_STD_MULTIPLIER;
  const statsById   = {};
  clustering.stats.forEach(s => { statsById[s.clusterId] = s; });

  const annotated = clustering.clusters.map((vehicle, i) => {
    const residual       = residuals[i];
    const predictedPrice = vehicle.price - residual;
    const isAnomaly      = threshold > 0 && Math.abs(residual) > threshold;
    const clusterAvgPrice = statsById[vehicle.clusterId]?.avgPrice ?? vehicle.price;
    const discountPercent = clusterAvgPrice > 0
      ? Math.round((1 - vehicle.price / clusterAvgPrice) * 100)
      : 0;
    const isGoodDeal = clusterAvgPrice > 0 && vehicle.price < clusterAvgPrice * GOOD_DEAL_THRESHOLD;
    return { ...vehicle, predictedPrice: Math.round(predictedPrice), residual: Math.round(residual), isAnomaly, clusterAvgPrice, discountPercent, isGoodDeal };
  });

  return { annotated, stats: clustering.stats, k: clustering.k };
}

// -------------------------------------------------------------
// MongoDB persistence helpers
// -------------------------------------------------------------
async function persistVehiclesToDB(vehicles) {
  try {
    const db      = getDb();
    const col     = db.collection(COL_VEHICLES);
    const batchId = new Date().toISOString();
    if (vehicles.length > 0) {
      await col.insertMany(vehicles.map(v => ({ ...v, batchId })), { ordered: false });
    }
    await col.deleteMany({ batchId: { $ne: batchId } });
    console.log(`MongoDB: Persisted ${vehicles.length} vehicles, batchId=${batchId}`);
  } catch (err) {
    console.error('MongoDB: Failed to persist vehicles', err.message);
  }
}

async function loadVehiclesFromDB() {
  try {
    const db  = getDb();
    const col = db.collection(COL_VEHICLES);
    const latest = await col
      .find({}, { projection: { batchId: 1 } })
      .sort({ batchId: -1 })
      .limit(1)
      .toArray();
    if (!latest.length) return [];
    const batchId = latest[0].batchId;
    const docs    = await col
      .find({ batchId }, { projection: { _id: 0, batchId: 0 } })
      .toArray();
    console.log(`MongoDB: Loaded ${docs.length} vehicles from DB, batchId=${batchId}`);
    return docs;
  } catch (err) {
    console.error('MongoDB: Failed to load vehicles', err.message);
    return [];
  }
}

// -------------------------------------------------------------
// Build response payload
// -------------------------------------------------------------
function buildUpdatePayload() {
  return {
    vehicles:     vehicleData,
    analytics:    computeAnalytics(vehicleData),
    clustering:   clusterResult,
    depreciation: depreciationData,
    lastUpdated,
  };
}

// -------------------------------------------------------------
// Data refresh  (on-demand, replaces setInterval)
// -------------------------------------------------------------
async function refreshData() {
  try {
    const rawData = await fetchVehicleData(60);
    priceModel    = trainModel(rawData);
    const { annotated, stats, k } = annotateVehicles(rawData, currentK);
    vehicleData      = annotated;
    clusterResult    = { clusters: annotated, stats, k };
    depreciationData = computeDepreciation(vehicleData);
    lastUpdated      = new Date().toISOString();
    await persistVehiclesToDB(vehicleData);
    console.log(`[${lastUpdated}] Data refreshed – ${vehicleData.length} vehicles, ${clusterResult.k} clusters`);
  } catch (err) {
    console.error('Error refreshing vehicle data', err.message);
  }
}

async function ensureFreshData() {
  await connectDB();
  const isStale = !lastUpdated || (Date.now() - new Date(lastUpdated).getTime()) > FETCH_INTERVAL_MS;
  if (vehicleData.length > 0 && !isStale) return; // warm instance, data is fresh
  if (vehicleData.length === 0) {
    const saved = await loadVehiclesFromDB();
    if (saved.length > 0) {
      // Restore from DB without a full re-fetch
      priceModel       = trainModel(saved);
      const { annotated, stats, k } = annotateVehicles(saved, currentK);
      vehicleData      = annotated;
      clusterResult    = { clusters: annotated, stats, k };
      depreciationData = computeDepreciation(vehicleData);
      lastUpdated      = new Date().toISOString();
      if (!isStale) return;
    }
  }
  await refreshData();
}

// -------------------------------------------------------------
// *** IMPORTANT: static files FIRST, before session/routes ***
// Serves public/index.html, public/app.js, public/style.css
// -------------------------------------------------------------
app.use(express.static(path.join(__dirname, '../public')));

// Explicit root route – ensures Vercel's serverless rewrite
// correctly returns index.html for the homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// -------------------------------------------------------------
// Session middleware (lazy-init so DB errors don't kill the page)
// -------------------------------------------------------------
let sessionMiddleware = null;
app.use(async (req, res, next) => {
  try {
    await connectDB();
    if (!sessionMiddleware) {
      sessionMiddleware = session({
        secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
        resave: false,
        saveUninitialized: false,
        store: buildSessionStore(),
        cookie: { maxAge: 1000 * 60 * 60 * 4 }, // 4 hours
      });
    }
    sessionMiddleware(req, res, next);
  } catch (err) {
    console.error('Session: Failed to initialize', err.message);
    res.status(503).json({ error: 'Service temporarily unavailable – database connection failed' });
  }
});

// Rate limiter for auth routes
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

app.use(express.json());

// -------------------------------------------------------------
// API routes
// -------------------------------------------------------------

// Cron / manual refresh
app.get('/api/refresh', async (req, res) => {
  await connectDB();
  await refreshData();
  res.json({ message: 'Data refreshed', lastUpdated });
});

// Snapshot – mirrors the old Socket.IO dataUpdate payload
app.get('/api/snapshot', async (req, res) => {
  await ensureFreshData();
  res.json(buildUpdatePayload());
});

// Vehicles with optional filtering
app.get('/api/vehicles', async (req, res) => {
  await ensureFreshData();
  const { filters, error } = parseVehicleFilters(req.query);
  if (error) return res.status(400).json({ error });
  const filtered = applyVehicleFilters(vehicleData, filters);
  res.json({ count: filtered.length, vehicles: filtered });
});

// Analytics
app.get('/api/analytics', async (req, res) => {
  await ensureFreshData();
  res.json(computeAnalytics(vehicleData));
});

// Depreciation
app.get('/api/depreciation', async (req, res) => {
  await ensureFreshData();
  res.json(depreciationData);
});

// Clusters
app.get('/api/clusters', async (req, res) => {
  await ensureFreshData();
  res.json(clusterResult);
});

// Re-train with new k
app.post('/api/clusters/retrain', async (req, res) => {
  await ensureFreshData();
  const requestedK = Number(req.body.k);
  currentK = Math.min(6, Math.max(2, isNaN(requestedK) ? 3 : requestedK));
  if (!priceModel) return res.status(503).json({ error: 'No data available yet' });
  const rawData = vehicleData.map(v => ({ id: v.id, brand: v.brand, model: v.model, price: v.price, mileage: v.mileage, engineSize: v.engineSize, age: v.age, fuelType: v.fuelType }));
  const { annotated, stats, k } = annotateVehicles(rawData, currentK);
  vehicleData    = annotated;
  clusterResult  = { clusters: annotated, stats, k };
  res.json(clusterResult);
});

// Predict price
app.post('/api/predict', async (req, res) => {
  await ensureFreshData();
  if (!priceModel) return res.status(503).json({ error: 'No data available yet' });
  const { mileage, engineSize, age } = req.body;
  const prediction = predict(priceModel, { mileage, engineSize, age });
  res.json({ predictedPrice: Math.round(prediction) });
});

// Brands list
app.get('/api/brands', async (req, res) => {
  await ensureFreshData();
  res.json([...new Set(vehicleData.map(v => v.brand))].sort());
});

// --- Auth ---
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required' });
  const ok = await auth.register(username, password);
  if (!ok) return res.status(409).json({ error: 'Username already exists' });
  req.session.user = username;
  res.json({ username, favorites: [] });
});

app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body;
  const valid = await auth.validate(username, password);
  if (!valid) return res.status(401).json({ error: 'Invalid username or password' });
  req.session.user = username;
  res.json({ username, favorites: await auth.getFavorites(username) });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ message: 'Logged out' }));
});

app.get('/api/me', async (req, res) => {
  res.json({
    username:  req.session.user ?? null,
    favorites: req.session.user ? await auth.getFavorites(req.session.user) : [],
  });
});

app.post('/api/favorites', async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'You must be logged in to save favorites' });
  const vehicle = req.body;
  if (!vehicle || !vehicle.id) return res.status(400).json({ error: 'A valid vehicle object with an id is required' });
  const favorites = await auth.toggleFavorite(req.session.user, vehicle);
  res.json({ favorites });
});

// -------------------------------------------------------------
// Local development entry point
// On Vercel this file is imported as a module and the code
// below never runs.
// -------------------------------------------------------------
if (require.main === module) {
  (async () => {
    await connectDB().catch(err => {
      console.error('MongoDB: Fatal – could not connect –', err.message);
      process.exit(1);
    });
    await ensureFreshData();
    app.listen(PORT, () => {
      console.log(`Car Analytics Dashboard running on http://localhost:${PORT}`);
    });
  })();
}

module.exports = app;
