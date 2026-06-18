// =============================================================
// api.js
// -------------------------------------------------------------
// This module is responsible for "fetching" vehicle data.
//
// REAL DATA vs. SIMULATED DATA
// -----------------------------
// Real used-car LISTING data (actual asking prices, mileage,
// engine size for a specific car for sale) is not available for
// free anywhere - every provider that offers this (Edmunds TMV,
// VinAudit, Zyla Market Value API, CarAPI Pro, etc.) is a paid
// product, because it's commercially valuable data licensed or
// scraped from dealers.
//
// What IS free, with no signup or API key, is the U.S. NHTSA
// vPIC API (https://vpic.nhtsa.dot.gov/api/) - a government-run
// vehicle reference database with real makes and real model
// names (e.g. "Camry", "Civic", "Model 3") for each brand. It does
// NOT include price, mileage, or engine size per listing.
//
// So this module fetches REAL brand + model NAMES from NHTSA,
// and still SIMULATES the numeric listing fields (price, mileage,
// engine size, year/age) using the same realistic generator logic
// as before - there is no free source for those.
//
// The make -> models lookup is cached in memory (and refreshed
// occasionally) so we don't hit NHTSA on every single data
// refresh cycle - NHTSA applies its own automated rate-control,
// so being a polite, infrequent caller matters.
//
// If NHTSA is unreachable or returns something unexpected, this
// module falls back to the original synthetic "Brand-123" model
// names so the dashboard never breaks because of a 3rd-party
// outage.
//
// UNITS: price is generated in INR (Indian Rupees), mileage is
// generated in kilometers (km).
// =============================================================

const BRANDS = [
  'Toyota', 'Honda', 'Ford', 'BMW', 'Mercedes', 'Audi',
  'Volkswagen', 'Hyundai', 'Kia', 'Nissan', 'Chevrolet', 'Tesla'
];

const FUEL_TYPES = ['Petrol', 'Diesel', 'Electric', 'Hybrid'];

// NHTSA's vPIC API expects standard manufacturer names; "Mercedes"
// needs to be "Mercedes-Benz" for accurate model results.
const NHTSA_MAKE_OVERRIDES = {
  Mercedes: 'Mercedes-Benz'
};

const NHTSA_BASE_URL = 'https://vpic.nhtsa.dot.gov/api/vehicles';
const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // refetch models every 6 hours
const NHTSA_FETCH_TIMEOUT_MS = 5000;

// In-memory cache: { [brand]: { models: string[], fetchedAt: number } }
// Best-effort only - on serverless, a cold start just refetches.
let modelCache = {};

// Helper: random number in range
function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

// Helper: random integer in range (inclusive)
function randInt(min, max) {
  return Math.floor(randRange(min, max + 1));
}

// Helper: pick random element from array
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Fetches real model names for a brand from NHTSA's free vPIC API.
 * Returns an array of model name strings, or [] on any failure
 * (network error, timeout, unexpected shape, empty result).
 */
async function fetchModelsFromNHTSA(brand) {
  const nhtsaMake = NHTSA_MAKE_OVERRIDES[brand] || brand;
  const url = `${NHTSA_BASE_URL}/getmodelsformake/${encodeURIComponent(nhtsaMake)}?format=json`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), NHTSA_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`NHTSA responded with status ${res.status}`);

    const data = await res.json();
    const results = Array.isArray(data.Results) ? data.Results : [];

    const models = [...new Set(
      results
        .map((r) => r.Model_Name)
        .filter((name) => typeof name === 'string' && name.trim().length > 0)
    )];

    return models;
  } catch (err) {
    console.error(`[NHTSA] Failed to fetch models for "${brand}":`, err.message);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Returns a cached list of real model names for a brand, fetching
 * from NHTSA if the cache is empty or stale. Falls back to a
 * single placeholder so callers always get a non-empty array.
 */
async function getModelsForBrand(brand) {
  const cached = modelCache[brand];
  const isStale = !cached || (Date.now() - cached.fetchedAt > MODEL_CACHE_TTL_MS);

  if (!isStale) return cached.models;

  const models = await fetchModelsFromNHTSA(brand);

  if (models.length > 0) {
    modelCache[brand] = { models, fetchedAt: Date.now() };
    return models;
  }

  // NHTSA failed or returned nothing - keep serving the old cached
  // list if we have one (better than nothing), otherwise fall back.
  if (cached) return cached.models;
  return [`${brand} Series`]; // generic fallback, still labeled clearly
}

/**
 * Pre-warms the model cache for every brand. Called once per
 * refresh cycle so generateVehicle() can stay synchronous and
 * just pick from already-fetched model lists.
 */
async function refreshModelCache() {
  await Promise.all(BRANDS.map((brand) => getModelsForBrand(brand)));
}

/**
 * Generates a single random vehicle record using a REAL model name
 * (from the pre-warmed NHTSA cache) but SIMULATED listing numbers.
 * Fields:
 *  - id: unique identifier
 *  - brand: car manufacturer
 *  - model: real model name fetched from NHTSA (falls back to a
 *    generic placeholder if NHTSA was unreachable)
 *  - fuelType: Petrol / Diesel / Electric / Hybrid
 *  - price: in INR (Indian Rupees) - SIMULATED, no free source exists
 *  - mileage: in kilometers (km) - SIMULATED
 *  - engineSize: in liters (Electric vehicles use kWh-equivalent placeholder) - SIMULATED
 *  - year: manufacturing year - SIMULATED
 *  - age: derived vehicle age in years
 */
function generateVehicle(idSeed) {
  const currentYear = new Date().getFullYear();
  const year = randInt(currentYear - 15, currentYear);
  const age = currentYear - year;
  const fuelType = pick(FUEL_TYPES);
  const brand = pick(BRANDS);

  const cachedModels = modelCache[brand]?.models;
  const model = cachedModels && cachedModels.length > 0
    ? pick(cachedModels)
    : `${brand} Series`;

  // Engine size depends loosely on fuel type for realism
  let engineSize;
  if (fuelType === 'Electric') {
    engineSize = parseFloat(randRange(0.5, 2.0).toFixed(1)); // placeholder "motor size" metric
  } else {
    engineSize = parseFloat(randRange(1.0, 5.0).toFixed(1));
  }

  // Mileage increases roughly with age (in kilometers)
  const mileage = Math.round((randRange(0, 15000) * age + randRange(0, 5000)) * 1.60934);

  // Base price depends on brand, engine size, and decreases with age/mileage
  // Prices are generated directly in INR (Indian Rupees) scale.
  const luxuryBrands = ['BMW', 'Mercedes', 'Audi', 'Tesla'];
  const basePrice = luxuryBrands.includes(brand)
    ? randRange(2900000, 7500000)   // ~29L - 75L INR for luxury brands
    : randRange(1000000, 3700000);  // ~10L - 37L INR for regular brands
  const depreciation = age * randRange(65000, 200000) + mileage * 1.5;
  let price = Math.max(150000, Math.round(basePrice - depreciation));

  return {
    id: idSeed,
    brand,
    model,
    fuelType,
    year,
    age,
    price,
    mileage,
    engineSize
  };
}

/**
 * Fetches a fresh batch of vehicle data.
 * Real brand/model names come from NHTSA's free vPIC API (cached);
 * price/mileage/engine-size/year are simulated, since no free
 * source for actual listing data exists.
 *
 * @param {number} count - number of vehicle records to generate
 * @returns {Promise<Array>} array of vehicle objects
 */
async function fetchVehicleData(count = 60) {
  await refreshModelCache();

  const vehicles = [];
  for (let i = 0; i < count; i++) {
    vehicles.push(generateVehicle(`v_${Date.now()}_${i}`));
  }
  return vehicles;
}

module.exports = { fetchVehicleData };
