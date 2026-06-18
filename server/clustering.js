// =============================================================
// clustering.js
// -------------------------------------------------------------
// Implements K-Means clustering from scratch (no external ML
// libraries) on vehicle data using 4 numeric features:
//   [price, mileage, engineSize, age]
//
// Because these features have very different scales (price is in
// lakhs/crores, engineSize is 0-5), we normalize (min-max
// scale) each feature to the range [0, 1] before clustering so
// that no single feature dominates the distance calculation.
//
// Exposes:
//   runKMeans(vehicles, k, maxIterations) -> {
//       clusters: [...vehicles with clusterId added],
//       stats: [...per-cluster aggregate statistics + centroid],
//       k: number of clusters actually used
//   }
//
// `k` is configurable (2-6) so the dashboard can let users
// retrain clustering on demand with a different number of
// segments.
// =============================================================

const FEATURES = ['price', 'mileage', 'engineSize', 'age'];
const DEFAULT_CLUSTERS = 3;
const MAX_ITERATIONS = 50;

/**
 * Compute min and max for each feature across the dataset.
 */
function computeFeatureRanges(vehicles) {
  const ranges = {};
  FEATURES.forEach((f) => {
    const values = vehicles.map((v) => v[f]);
    ranges[f] = { min: Math.min(...values), max: Math.max(...values) };
  });
  return ranges;
}

/**
 * Normalize a vehicle's features to [0, 1] using min-max scaling.
 */
function normalizeVehicle(vehicle, ranges) {
  return FEATURES.map((f) => {
    const { min, max } = ranges[f];
    if (max === min) return 0; // avoid divide-by-zero if all values equal
    return (vehicle[f] - min) / (max - min);
  });
}

/**
 * Convert a normalized centroid vector back into real-world units
 * (price in INR, mileage in km, engineSize in L, age in years).
 */
function denormalizeCentroid(centroid, ranges) {
  const result = {};
  FEATURES.forEach((f, i) => {
    const { min, max } = ranges[f];
    const value = max === min ? min : centroid[i] * (max - min) + min;
    result[f] = Math.round(value * 100) / 100;
  });
  return result;
}

/**
 * Euclidean distance between two normalized feature vectors.
 */
function euclideanDistance(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += (a[i] - b[i]) ** 2;
  }
  return Math.sqrt(sum);
}

/**
 * Initialize centroids using the k-means++ algorithm: pick the
 * first centroid uniformly at random, then each subsequent
 * centroid is chosen from the remaining points with probability
 * proportional to its squared distance from the nearest existing
 * centroid. This gives more stable, better-spread initial
 * centroids than pure random selection, so cluster labels
 * (Budget/Mid-range/Premium...) don't jump around as much between
 * retrains.
 */
function initializeCentroids(data, k) {
  const centroids = [];
  const firstIdx = Math.floor(Math.random() * data.length);
  centroids.push([...data[firstIdx]]);

  while (centroids.length < k) {
    const distances = data.map((point) => {
      let minDist = Infinity;
      for (const centroid of centroids) {
        const d = euclideanDistance(point, centroid);
        if (d < minDist) minDist = d;
      }
      return minDist * minDist;
    });

    const totalDist = distances.reduce((a, b) => a + b, 0);

    if (totalDist === 0) {
      // All remaining points are identical to existing centroids;
      // fall back to a random pick to avoid an infinite loop.
      const idx = Math.floor(Math.random() * data.length);
      centroids.push([...data[idx]]);
      continue;
    }

    let r = Math.random() * totalDist;
    let chosenIdx = 0;
    for (let i = 0; i < distances.length; i++) {
      r -= distances[i];
      if (r <= 0) {
        chosenIdx = i;
        break;
      }
    }
    centroids.push([...data[chosenIdx]]);
  }

  return centroids;
}

/**
 * Assign each data point to the nearest centroid.
 * Returns an array of cluster indices (same length as data).
 */
function assignClusters(data, centroids) {
  return data.map((point) => {
    let minDist = Infinity;
    let clusterIndex = 0;
    centroids.forEach((centroid, idx) => {
      const dist = euclideanDistance(point, centroid);
      if (dist < minDist) {
        minDist = dist;
        clusterIndex = idx;
      }
    });
    return clusterIndex;
  });
}

/**
 * Recompute centroids as the mean of all points assigned to each cluster.
 * If a cluster ends up empty, re-seed it with a random data point to
 * avoid losing a cluster entirely.
 */
function recomputeCentroids(data, assignments, k, dims) {
  const sums = Array.from({ length: k }, () => new Array(dims).fill(0));
  const counts = new Array(k).fill(0);

  data.forEach((point, i) => {
    const cluster = assignments[i];
    counts[cluster]++;
    for (let d = 0; d < dims; d++) {
      sums[cluster][d] += point[d];
    }
  });

  return sums.map((sum, idx) => {
    if (counts[idx] === 0) {
      return [...data[Math.floor(Math.random() * data.length)]];
    }
    return sum.map((s) => s / counts[idx]);
  });
}

/**
 * Core K-Means algorithm. Iterates assign -> recompute until
 * convergence (no change in assignments) or maxIterations reached.
 */
function kMeans(data, k, maxIterations) {
  if (data.length === 0) {
    return { assignments: [], centroids: [] };
  }
  const effectiveK = Math.min(k, data.length);
  let centroids = initializeCentroids(data, effectiveK);
  let assignments = new Array(data.length).fill(-1);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAssignments = assignClusters(data, centroids);

    const changed = newAssignments.some((a, i) => a !== assignments[i]);
    assignments = newAssignments;

    if (!changed && iter > 0) break;

    centroids = recomputeCentroids(data, assignments, effectiveK, data[0].length);
  }

  return { assignments, centroids };
}

/**
 * Given a list of vehicles, run K-Means clustering on the
 * [price, mileage, engineSize, age] feature space and return:
 *  - vehicles annotated with clusterId + clusterLabel
 *  - per-cluster summary statistics (avg price, mileage, etc.)
 *    including a denormalized centroid in real-world units
 *  - a human-friendly label per cluster (e.g. "Budget", "Premium")
 */
function runKMeans(vehicles, k = DEFAULT_CLUSTERS, maxIterations = MAX_ITERATIONS) {
  if (!vehicles || vehicles.length === 0) {
    return { clusters: [], stats: [], k: 0 };
  }

  // Clamp k to a sensible 2-6 range
  const targetK = Math.min(6, Math.max(2, Math.round(k)));

  const ranges = computeFeatureRanges(vehicles);
  const normalizedData = vehicles.map((v) => normalizeVehicle(v, ranges));

  const { assignments, centroids } = kMeans(normalizedData, targetK, maxIterations);

  const clusteredVehicles = vehicles.map((v, i) => ({
    ...v,
    clusterId: assignments[i]
  }));

  const effectiveK = centroids.length;
  const stats = [];
  for (let c = 0; c < effectiveK; c++) {
    const members = clusteredVehicles.filter((v) => v.clusterId === c);
    if (members.length === 0) {
      stats.push({
        clusterId: c,
        count: 0,
        avgPrice: 0,
        avgMileage: 0,
        avgEngineSize: 0,
        avgAge: 0,
        label: 'Empty',
        centroid: denormalizeCentroid(centroids[c], ranges)
      });
      continue;
    }
    const avg = (key) =>
      members.reduce((sum, v) => sum + v[key], 0) / members.length;

    stats.push({
      clusterId: c,
      count: members.length,
      avgPrice: Math.round(avg('price')),
      avgMileage: Math.round(avg('mileage')),
      avgEngineSize: parseFloat(avg('engineSize').toFixed(2)),
      avgAge: parseFloat(avg('age').toFixed(1)),
      centroid: denormalizeCentroid(centroids[c], ranges)
    });
  }

  // Label clusters based on average price ranking (Budget / Mid-range / Premium / ...)
  const sortedByPrice = [...stats]
    .filter((s) => s.count > 0)
    .sort((a, b) => a.avgPrice - b.avgPrice);

  const labelNames = ['Budget', 'Mid-range', 'Premium', 'Luxury', 'Ultra-Luxury', 'Elite'];
  sortedByPrice.forEach((s, idx) => {
    const target = stats.find((st) => st.clusterId === s.clusterId);
    target.label = labelNames[idx] || `Segment ${idx + 1}`;
  });

  const labelMap = {};
  stats.forEach((s) => {
    labelMap[s.clusterId] = s.label;
  });
  clusteredVehicles.forEach((v) => {
    v.clusterLabel = labelMap[v.clusterId] || 'Unknown';
  });

  return {
    clusters: clusteredVehicles,
    stats,
    k: effectiveK
  };
}

module.exports = { runKMeans };