// =============================================================
// regression.js
// -------------------------------------------------------------
// Implements a small multivariate Linear Regression model
// (trained via batch gradient descent) to predict a vehicle's
// "fair" price based on:
//   - mileage
//   - age
//   - engineSize
//   - brand (one-hot encoded)
//
// This model is retrained every time fresh vehicle data arrives
// (see server.js). It powers two features:
//   1. The "Price Prediction" tool (POST /api/predict)
//   2. Anomaly detection - vehicles whose actual price deviates
//      strongly from the model's predicted price are flagged as
//      statistical outliers (over/under-priced).
// =============================================================

// Numeric features are min-max normalized to [0, 1]. Price is
// scaled down by PRICE_SCALE so gradient descent converges
// quickly with simple fixed learning rates.
const PRICE_SCALE = 1000000; // 1 = ₹10,00,000 (10 lakh)
const NUMERIC_FEATURES = ['mileage', 'age', 'engineSize'];

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/**
 * Compute min/max ranges for the numeric features across the
 * training dataset, used for normalization.
 */
function computeRanges(vehicles) {
  const ranges = {};
  NUMERIC_FEATURES.forEach((f) => {
    const values = vehicles.map((v) => v[f]);
    ranges[f] = { min: Math.min(...values), max: Math.max(...values) };
  });
  return ranges;
}

/**
 * Build the feature vector for a single vehicle:
 *   [normMileage, normAge, normEngineSize, ...oneHotBrand]
 */
function buildFeatures(vehicle, ranges, brands) {
  const norm = (val, key) => {
    const { min, max } = ranges[key];
    if (max === min) return 0;
    return (val - min) / (max - min);
  };

  const numeric = NUMERIC_FEATURES.map((f) => norm(vehicle[f], f));
  const oneHot = brands.map((b) => (vehicle.brand === b ? 1 : 0));
  return [...numeric, ...oneHot];
}

/**
 * Trains a linear regression model on the given vehicles using
 * batch gradient descent.
 *
 * Returns a model object: { weights, bias, ranges, brands }
 * which can be passed to predict() / computeResiduals().
 */
function trainModel(vehicles, epochs = 1000, learningRate = 0.5) {
  if (!vehicles || vehicles.length === 0) {
    return { weights: [], bias: 0, ranges: {}, brands: [] };
  }

  const brands = [...new Set(vehicles.map((v) => v.brand))].sort();
  const ranges = computeRanges(vehicles);

  const X = vehicles.map((v) => buildFeatures(v, ranges, brands));
  const y = vehicles.map((v) => v.price / PRICE_SCALE);

  const numFeatures = X[0].length;
  const m = X.length;

  let weights = new Array(numFeatures).fill(0);
  let bias = 0;

  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(numFeatures).fill(0);
    let gradB = 0;

    for (let i = 0; i < m; i++) {
      const prediction = dot(X[i], weights) + bias;
      const error = prediction - y[i];

      for (let j = 0; j < numFeatures; j++) {
        gradW[j] += error * X[i][j];
      }
      gradB += error;
    }

    for (let j = 0; j < numFeatures; j++) {
      weights[j] -= (learningRate * gradW[j]) / m;
    }
    bias -= (learningRate * gradB) / m;
  }

  return { weights, bias, ranges, brands };
}

/**
 * Predicts a "fair price" (in INR) for a vehicle described by
 * { brand, mileage, age, engineSize } using a trained model.
 */
function predict(model, vehicleLike) {
  if (!model.weights || model.weights.length === 0) return 0;
  const features = buildFeatures(vehicleLike, model.ranges, model.brands);
  const predictedScaled = dot(features, model.weights) + model.bias;
  return Math.max(0, Math.round(predictedScaled * PRICE_SCALE));
}

/**
 * Computes residuals (actual price - predicted price) for every
 * vehicle in the array, in the same order as the input array.
 * Large absolute residuals indicate possible pricing anomalies.
 */
function computeResiduals(model, vehicles) {
  return vehicles.map((v) => v.price - predict(model, v));
}

module.exports = { trainModel, predict, computeResiduals };