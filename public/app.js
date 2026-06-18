// =============================================================
// app.js
// -------------------------------------------------------------
// Frontend logic for the Car Analytics Dashboard.
//
// Sections in this file:
//   1. Global state & DOM references
//   2. Theme toggle (dark/light, persisted in localStorage)
//   3. Top navigation tab switching
//   4. Polling-based live updates (snapshot fetch on interval)
//   5. Brand / cluster filter dropdown population
//   6. Search & Filter tab logic (REST calls + special filters)
//   7. Master render + all chart renderers
//   8. K-Means cluster stats, scatter (centroids + trend line), K-slider
//   9. Vehicle table (favorites star + flags) + quick search
//  10. Compare tab (table, radar chart, best-pick recommendation)
//  11. Price Prediction tab
//  12. Best Deals tab
//  13. Favorites tab (persisted vehicle snapshots, survive refresh)
//  14. Toast notifications
//  15. Login / Register modals + profile dropdown (header)
// =============================================================

// -------------------------------------------------------------
// 1. Global state
// -------------------------------------------------------------
let currentVehicles = [];
let currentAnalytics = {};
let currentClustering = { clusters: [], stats: [], k: 0 };
let currentDepreciation = { brands: [], series: {} };
let allVehiclesUnfiltered = [];

let selectedClusterId = '';
let compareList = [];

// favoritesMap stores full vehicle SNAPSHOTS keyed by vehicle id.
// Snapshots are used (rather than just IDs) so that favorited
// vehicles remain visible in the Favorites tab even after the
// dataset refreshes and generates new IDs.
let favoritesMap = new Map();
let currentUser = null;
let loginFailCount = 0;
const MAX_LOGIN_ATTEMPTS = 5;

let priceTrendHistory = []; // [{ time, avgPrice }]
const PRICE_TREND_MAX_POINTS = 20;

let charts = {};

// -------------------------------------------------------------
// DOM references
// -------------------------------------------------------------
const elTotalVehicles = document.getElementById('totalVehicles');
const elAvgPrice = document.getElementById('avgPrice');
const elAvgMileage = document.getElementById('avgMileage');
const elAvgEngineSize = document.getElementById('avgEngineSize');
const elGoodDealsCount = document.getElementById('goodDealsCount');
const elAnomaliesCount = document.getElementById('anomaliesCount');
const elLastUpdated = document.getElementById('lastUpdated');
const elConnectionStatus = document.getElementById('connectionStatus');
const elVehicleTableBody = document.getElementById('vehicleTableBody');
const elClusterStatsGrid = document.getElementById('clusterStatsGrid');
const elFilterBrand = document.getElementById('filterBrand');
const elClusterFilter = document.getElementById('clusterFilter');
const elTableSearchInput = document.getElementById('tableSearchInput');
const elCompareContent = document.getElementById('compareContent');
const elCompareChartsWrapper = document.getElementById('compareChartsWrapper');
const elBestPickCard = document.getElementById('bestPickCard');
const elKSlider = document.getElementById('kSlider');
const elKValue = document.getElementById('kValue');
const elPredictBrand = document.getElementById('predictBrand');
const elPredictResult = document.getElementById('predictResult');
const elDealsTableBody = document.getElementById('dealsTableBody');
const elFavoritesTableBody = document.getElementById('favoritesTableBody');
const elFavoritesSubtitle = document.getElementById('favoritesSubtitle');
const elToastContainer = document.getElementById('toastContainer');

// -------------------------------------------------------------
// Formatting helpers
// -------------------------------------------------------------
function formatCurrency(value) {
  return '₹' + Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// =============================================================
// 2. Theme toggle (dark / light)
// =============================================================
const elThemeToggleBtn = document.getElementById('themeToggleBtn');

function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    elThemeToggleBtn.textContent = '☀️';
  } else {
    document.documentElement.removeAttribute('data-theme');
    elThemeToggleBtn.textContent = '🌙';
  }
}

applyTheme(localStorage.getItem('carDashboardTheme') || 'dark');

elThemeToggleBtn.addEventListener('click', () => {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('carDashboardTheme', next);
  renderAll();
});

// =============================================================
// 3. Top Navigation (tab switching)
// =============================================================
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;

    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');

    document.querySelectorAll('.tab-section').forEach((sec) => sec.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');

    if (tab === 'deals') renderDealsTable();
    if (tab === 'favorites') renderFavoritesTable();
  });
});

// =============================================================
// 4. Polling-based live updates (replaces Socket.IO)
// -------------------------------------------------------------
// Vercel serverless functions can't hold a persistent WebSocket
// connection open, so instead of a push-based `dataUpdate` event,
// the frontend now periodically fetches a full snapshot from
// /api/snapshot and feeds it through the exact same handler that
// used to process Socket.IO's `dataUpdate` payload.
// =============================================================
const POLL_INTERVAL_MS = 30 * 1000; // poll every 30s

function setConnectionStatus(connected) {
  if (connected) {
    elConnectionStatus.textContent = 'Live';
    elConnectionStatus.className = 'status status-connected';
  } else {
    elConnectionStatus.textContent = 'Disconnected';
    elConnectionStatus.className = 'status status-disconnected';
  }
}

function handleDataUpdate(payload) {
  allVehiclesUnfiltered = payload.vehicles;
  currentClustering = payload.clustering;
  currentDepreciation = payload.depreciation || { brands: [], series: {} };

  populateBrandOptions(allVehiclesUnfiltered);
  populateClusterFilterOptions(currentClustering);
  populatePredictBrandOptions(allVehiclesUnfiltered);

  if (payload.analytics && payload.analytics.totalVehicles > 0) {
    priceTrendHistory.push({
      time: payload.lastUpdated ? new Date(payload.lastUpdated) : new Date(),
      avgPrice: payload.analytics.avgPrice
    });
    if (priceTrendHistory.length > PRICE_TREND_MAX_POINTS) {
      priceTrendHistory.shift();
    }
  }

  if (!areFiltersActive()) {
    currentVehicles = allVehiclesUnfiltered;
    currentAnalytics = payload.analytics;
    renderAll();
  } else {
    applyFilters();
  }

  if (payload.lastUpdated) {
    const d = new Date(payload.lastUpdated);
    elLastUpdated.textContent = 'Last updated: ' + d.toLocaleTimeString();
  }

  // NOTE: favoritesMap is NOT cleared or rebuilt here, so favorited
  // vehicle snapshots persist across refreshes even though the
  // underlying dataset gets new IDs.
  if (document.getElementById('tab-deals').classList.contains('active')) renderDealsTable();
  if (document.getElementById('tab-favorites').classList.contains('active')) renderFavoritesTable();
}

async function pollSnapshot() {
  try {
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error('Snapshot request failed: ' + res.status);
    const payload = await res.json();
    setConnectionStatus(true);
    handleDataUpdate(payload);
  } catch (err) {
    console.error('Polling error:', err.message);
    setConnectionStatus(false);
  }
}

// Initial fetch right away, then poll on an interval.
pollSnapshot();
setInterval(pollSnapshot, POLL_INTERVAL_MS);


// =============================================================
// 5. Dropdown population
// =============================================================
function populateBrandOptions(vehicles) {
  const currentValue = elFilterBrand.value;
  const brands = [...new Set(vehicles.map((v) => v.brand))].sort();

  elFilterBrand.innerHTML = '<option value="">All Brands</option>';
  brands.forEach((brand) => {
    const opt = document.createElement('option');
    opt.value = brand;
    opt.textContent = brand;
    elFilterBrand.appendChild(opt);
  });
  if (brands.includes(currentValue)) {
    elFilterBrand.value = currentValue;
  }
}

function populateClusterFilterOptions(clustering) {
  const currentValue = elClusterFilter.value;
  elClusterFilter.innerHTML = '<option value="">All Segments</option>';

  (clustering.stats || []).forEach((stat) => {
    const opt = document.createElement('option');
    opt.value = stat.clusterId;
    opt.textContent = `${stat.label} (Cluster ${stat.clusterId})`;
    elClusterFilter.appendChild(opt);
  });

  const stillValid = (clustering.stats || []).some((s) => String(s.clusterId) === String(currentValue));
  elClusterFilter.value = stillValid ? currentValue : '';
  selectedClusterId = elClusterFilter.value;
}

elClusterFilter.addEventListener('change', () => {
  selectedClusterId = elClusterFilter.value;
  renderClusterStats(currentClustering);
  renderClusterScatter(currentVehicles, currentClustering);
});

function populatePredictBrandOptions(vehicles) {
  const currentValue = elPredictBrand.value;
  const brands = [...new Set(vehicles.map((v) => v.brand))].sort();

  elPredictBrand.innerHTML = '';
  brands.forEach((brand) => {
    const opt = document.createElement('option');
    opt.value = brand;
    opt.textContent = brand;
    elPredictBrand.appendChild(opt);
  });
  if (brands.includes(currentValue)) {
    elPredictBrand.value = currentValue;
  }
}

// =============================================================
// 6. Search & Filter tab
// =============================================================
function getFilterValues() {
  return {
    brand: document.getElementById('filterBrand').value,
    fuelType: document.getElementById('filterFuelType').value,
    minPrice: document.getElementById('filterMinPrice').value,
    maxPrice: document.getElementById('filterMaxPrice').value,
    minMileage: document.getElementById('filterMinMileage').value,
    maxMileage: document.getElementById('filterMaxMileage').value,
    goodDealOnly: document.getElementById('filterGoodDeal').checked ? 'true' : '',
    anomalyOnly: document.getElementById('filterAnomaly').checked ? 'true' : ''
  };
}

function areFiltersActive() {
  const f = getFilterValues();
  return Object.values(f).some((v) => v !== '' && v !== null && v !== undefined);
}

async function applyFilters() {
  const f = getFilterValues();
  const params = new URLSearchParams();
  Object.entries(f).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) {
      params.append(key, value);
    }
  });

  try {
    const [vehiclesRes, analyticsRes] = await Promise.all([
      fetch('/api/vehicles?' + params.toString()),
      fetch('/api/analytics?' + params.toString())
    ]);

    const vehiclesData = await vehiclesRes.json();
    const analyticsData = await analyticsRes.json();

    currentVehicles = vehiclesData.vehicles;
    currentAnalytics = analyticsData;

    renderAll();
  } catch (err) {
    console.error('Error applying filters:', err);
  }
}

function clearFilters() {
  document.getElementById('filterBrand').value = '';
  document.getElementById('filterFuelType').value = '';
  document.getElementById('filterMinPrice').value = '';
  document.getElementById('filterMaxPrice').value = '';
  document.getElementById('filterMinMileage').value = '';
  document.getElementById('filterMaxMileage').value = '';
  document.getElementById('filterGoodDeal').checked = false;
  document.getElementById('filterAnomaly').checked = false;
  elTableSearchInput.value = '';

  currentVehicles = allVehiclesUnfiltered;
  fetch('/api/analytics')
    .then((res) => res.json())
    .then((data) => {
      currentAnalytics = data;
      renderAll();
    });
}

document.getElementById('applyFiltersBtn').addEventListener('click', applyFilters);
document.getElementById('clearFiltersBtn').addEventListener('click', clearFilters);
document.getElementById('refreshBtn').addEventListener('click', async () => {
  try {
    await fetch('/api/refresh', { method: 'POST' });
  } catch (err) {
    console.error('Manual refresh failed:', err.message);
  }
  pollSnapshot(); // fetch the latest snapshot right away instead of waiting for the next poll tick
});

elTableSearchInput.addEventListener('input', () => {
  renderVehicleTable(getTableDisplayVehicles(), currentClustering);
});

function getTableDisplayVehicles() {
  const query = elTableSearchInput.value.trim().toLowerCase();
  if (!query) return currentVehicles;
  return currentVehicles.filter(
    (v) =>
      v.brand.toLowerCase().includes(query) ||
      v.model.toLowerCase().includes(query)
  );
}

// =============================================================
// 7. Master render + chart renderers
// =============================================================
function renderAll() {
  renderSummaryCards(currentAnalytics, currentVehicles);
  renderPriceHistogram(currentVehicles);
  renderMileagePriceScatter(currentVehicles);
  renderFuelPieChart(currentAnalytics);
  renderAgeBarChart(currentAnalytics);
  renderBrandPriceChart(currentVehicles);
  renderDepreciationChart(currentDepreciation);
  renderPriceTrendChart();
  renderClusterStats(currentClustering);
  renderClusterScatter(currentVehicles, currentClustering);
  renderVehicleTable(getTableDisplayVehicles(), currentClustering);
}

function renderSummaryCards(analytics, vehicles) {
  elTotalVehicles.textContent = formatNumber(analytics.totalVehicles || 0);
  elAvgPrice.textContent = formatCurrency(analytics.avgPrice || 0);
  elAvgMileage.textContent = formatNumber(analytics.avgMileage || 0) + ' km';
  elAvgEngineSize.textContent = (analytics.avgEngineSize || 0) + ' L';

  const goodDeals = vehicles.filter((v) => v.isGoodDeal).length;
  const anomalies = vehicles.filter((v) => v.isAnomaly).length;
  elGoodDealsCount.textContent = formatNumber(goodDeals);
  elAnomaliesCount.textContent = formatNumber(anomalies);
}

function destroyChart(key) {
  if (charts[key]) {
    charts[key].destroy();
    delete charts[key];
  }
}

function getChartColors() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  return {
    text: isLight ? '#0f172a' : '#e8ecf7',
    dim: isLight ? '#3f4a63' : '#93a4c9',
    grid: isLight ? '#d6e0f5' : '#1e2540'
  };
}

// -------------------------------------------------------------
// Price Distribution Histogram
// -------------------------------------------------------------
function renderPriceHistogram(vehicles) {
  const ctx = document.getElementById('priceHistogramChart');
  destroyChart('priceHistogram');
  if (vehicles.length === 0) return;
  const colors = getChartColors();

  const prices = vehicles.map((v) => v.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const binCount = 8;
  const binSize = Math.max(1, Math.ceil((max - min) / binCount));

  const bins = new Array(binCount).fill(0);
  const labels = [];
  for (let i = 0; i < binCount; i++) {
    const binStart = min + i * binSize;
    const binEnd = binStart + binSize;
    labels.push(`₹${formatNumber(binStart)} - ₹${formatNumber(binEnd)}`);
  }

  prices.forEach((price) => {
    let idx = Math.floor((price - min) / binSize);
    if (idx >= binCount) idx = binCount - 1;
    if (idx < 0) idx = 0;
    bins[idx]++;
  });

  charts.priceHistogram = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Number of Vehicles', data: bins, backgroundColor: '#3b82f6' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.dim, maxRotation: 45, minRotation: 45 }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.dim }, grid: { color: colors.grid }, beginAtZero: true }
      }
    }
  });
}

// -------------------------------------------------------------
// Mileage vs Price Scatter Plot
// -------------------------------------------------------------
function renderMileagePriceScatter(vehicles) {
  const ctx = document.getElementById('mileagePriceScatterChart');
  destroyChart('mileagePriceScatter');
  const colors = getChartColors();

  const data = vehicles.map((v) => ({ x: v.mileage, y: v.price }));

  charts.mileagePriceScatter = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{ label: 'Vehicles', data, backgroundColor: 'rgba(59, 130, 246, 0.6)' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { title: { display: true, text: 'Mileage (km)', color: colors.dim }, ticks: { color: colors.dim }, grid: { color: colors.grid } },
        y: { title: { display: true, text: 'Price (₹)', color: colors.dim }, ticks: { color: colors.dim }, grid: { color: colors.grid } }
      }
    }
  });
}

// -------------------------------------------------------------
// Fuel Type Pie Chart
// -------------------------------------------------------------
function renderFuelPieChart(analytics) {
  const ctx = document.getElementById('fuelPieChart');
  destroyChart('fuelPie');
  const colors = getChartColors();

  const dist = analytics.fuelDistribution || {};
  const labels = Object.keys(dist);
  const data = Object.values(dist);
  const palette = ['#3b82f6', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#0ea5e9'];

  charts.fuelPie = new Chart(ctx, {
    type: 'pie',
    data: { labels, datasets: [{ data, backgroundColor: palette.slice(0, labels.length) }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: colors.text } } }
    }
  });
}

// -------------------------------------------------------------
// Vehicle Age Distribution Bar Chart
// -------------------------------------------------------------
function renderAgeBarChart(analytics) {
  const ctx = document.getElementById('ageBarChart');
  destroyChart('ageBar');
  const colors = getChartColors();

  const dist = analytics.ageDistribution || {};
  const labels = Object.keys(dist);
  const data = Object.values(dist);

  charts.ageBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.map((l) => l + ' yrs'),
      datasets: [{ label: 'Number of Vehicles', data, backgroundColor: '#a78bfa' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.dim }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.dim }, grid: { color: colors.grid }, beginAtZero: true }
      }
    }
  });
}

// -------------------------------------------------------------
// Average Price by Brand (Bar) - centered card
// -------------------------------------------------------------
function renderBrandPriceChart(vehicles) {
  const ctx = document.getElementById('brandPriceChart');
  destroyChart('brandPrice');
  if (vehicles.length === 0) return;
  const colors = getChartColors();

  const byBrand = {};
  vehicles.forEach((v) => {
    if (!byBrand[v.brand]) byBrand[v.brand] = { sum: 0, count: 0 };
    byBrand[v.brand].sum += v.price;
    byBrand[v.brand].count++;
  });

  const entries = Object.entries(byBrand)
    .map(([brand, { sum, count }]) => ({ brand, avg: Math.round(sum / count) }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 10);

  charts.brandPrice = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: entries.map((e) => e.brand),
      datasets: [{ label: 'Average Price (₹)', data: entries.map((e) => e.avg), backgroundColor: '#f472b6' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.dim, callback: (v) => '₹' + formatNumber(v) }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.dim }, grid: { color: colors.grid } }
      }
    }
  });
}

// -------------------------------------------------------------
// Depreciation Curve (Avg Price by Age, per Brand) - centered card
// -------------------------------------------------------------
function renderDepreciationChart(depreciation) {
  const ctx = document.getElementById('depreciationChart');
  destroyChart('depreciation');
  const colors = getChartColors();

  const palette = ['#3b82f6', '#34d399', '#fbbf24', '#f472b6', '#a78bfa', '#0ea5e9'];
  const brands = depreciation.brands || [];

  const datasets = brands.map((brand, idx) => ({
    label: brand,
    data: (depreciation.series[brand] || []).map((p) => ({ x: p.age, y: p.avgPrice })),
    borderColor: palette[idx % palette.length],
    backgroundColor: 'transparent',
    tension: 0.3,
    pointRadius: 3
  }));

  charts.depreciation = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: colors.text } } },
      scales: {
        x: { type: 'linear', title: { display: true, text: 'Age (years)', color: colors.dim }, ticks: { color: colors.dim }, grid: { color: colors.grid } },
        y: { title: { display: true, text: 'Avg Price (₹)', color: colors.dim }, ticks: { color: colors.dim, callback: (v) => '₹' + formatNumber(v) }, grid: { color: colors.grid } }
      }
    }
  });
}

// -------------------------------------------------------------
// Live Average Price Trend - centered card
// -------------------------------------------------------------
function renderPriceTrendChart() {
  const ctx = document.getElementById('priceTrendChart');
  destroyChart('priceTrend');
  const colors = getChartColors();

  charts.priceTrend = new Chart(ctx, {
    type: 'line',
    data: {
      labels: priceTrendHistory.map((p) => p.time.toLocaleTimeString()),
      datasets: [{
        label: 'Average Price (₹)',
        data: priceTrendHistory.map((p) => p.avgPrice),
        borderColor: '#34d399',
        backgroundColor: 'rgba(52, 211, 153, 0.15)',
        tension: 0.3,
        fill: true,
        pointRadius: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: colors.dim, maxRotation: 45, minRotation: 45 }, grid: { color: colors.grid } },
        y: { ticks: { color: colors.dim, callback: (v) => '₹' + formatNumber(v) }, grid: { color: colors.grid } }
      }
    }
  });
}

// =============================================================
// 8. K-Means Cluster Stats, Scatter (centroids + trend line), K-slider
// =============================================================
elKSlider.addEventListener('input', () => {
  elKValue.textContent = elKSlider.value;
});

document.getElementById('retrainBtn').addEventListener('click', async () => {
  const k = Number(elKSlider.value);
  const btn = document.getElementById('retrainBtn');
  btn.disabled = true;
  btn.textContent = 'Retraining...';
  try {
    await fetch('/api/clusters/retrain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ k })
    });
  } catch (err) {
    console.error('Error retraining clusters:', err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Retrain Clusters';
  }
});

function renderClusterStats(clustering) {
  elClusterStatsGrid.innerHTML = '';

  if (!clustering.stats || clustering.stats.length === 0) {
    elClusterStatsGrid.innerHTML = '<p style="color:var(--text-dim);">No clustering data available.</p>';
    return;
  }

  const statsToShow = selectedClusterId === ''
    ? clustering.stats
    : clustering.stats.filter((s) => String(s.clusterId) === String(selectedClusterId));

  statsToShow.forEach((stat) => {
    const card = document.createElement('div');
    card.className = 'cluster-card';
    if (String(stat.clusterId) === String(selectedClusterId)) {
      card.classList.add('selected');
    }
    card.dataset.clusterId = stat.clusterId;
    card.innerHTML = `
      <h4>${stat.label} <span class="cluster-badge cluster-${stat.clusterId}">Cluster ${stat.clusterId}</span></h4>
      <div>Vehicles: ${stat.count}</div>
      <div>Avg Price: ${formatCurrency(stat.avgPrice)}</div>
      <div>Avg Mileage: ${formatNumber(stat.avgMileage)} km</div>
      <div>Avg Engine Size: ${stat.avgEngineSize} L</div>
      <div>Avg Age: ${stat.avgAge} yrs</div>
    `;

    card.addEventListener('click', () => {
      const clickedId = String(stat.clusterId);
      selectedClusterId = (selectedClusterId === clickedId) ? '' : clickedId;
      elClusterFilter.value = selectedClusterId;
      renderClusterStats(clustering);
      renderClusterScatter(currentVehicles, clustering);
    });

    elClusterStatsGrid.appendChild(card);
  });
}

function renderClusterScatter(vehicles, clustering) {
  const ctx = document.getElementById('clusterScatterChart');
  destroyChart('clusterScatter');
  const colors = getChartColors();

  if (!clustering.clusters || clustering.clusters.length === 0) return;

  const displayedIds = new Set(vehicles.map((v) => v.id));
  const palette = ['#3b82f6', '#60a5fa', '#a78bfa', '#f472b6', '#0ea5e9', '#34d399'];
  const labelMap = {};
  const centroidMap = {};
  clustering.stats.forEach((s) => {
    labelMap[s.clusterId] = s.label;
    centroidMap[s.clusterId] = s.centroid;
  });

  const datasetsMap = {};
  clustering.clusters.forEach((v) => {
    if (!displayedIds.has(v.id)) return;
    if (!datasetsMap[v.clusterId]) datasetsMap[v.clusterId] = [];
    datasetsMap[v.clusterId].push({ x: v.mileage, y: v.price });
  });

  let datasets = [];

  if (selectedClusterId !== '' && datasetsMap[selectedClusterId]) {
    const points = [...datasetsMap[selectedClusterId]].sort((a, b) => a.x - b.x);
    const color = palette[selectedClusterId % palette.length];

    datasets.push({
      type: 'scatter',
      label: `${labelMap[selectedClusterId] || 'Cluster'} (${selectedClusterId})`,
      data: points,
      backgroundColor: color,
      showLine: false
    });

    datasets.push({
      type: 'line',
      label: `${labelMap[selectedClusterId] || 'Cluster'} trend line`,
      data: points,
      borderColor: color,
      backgroundColor: 'transparent',
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      fill: false
    });

    const c = centroidMap[selectedClusterId];
    if (c) {
      datasets.push({
        type: 'scatter',
        label: `${labelMap[selectedClusterId] || 'Cluster'} centroid`,
        data: [{ x: c.mileage, y: c.price }],
        backgroundColor: '#fbbf24',
        pointStyle: 'star',
        radius: 10,
        borderColor: '#fff',
        borderWidth: 1
      });
    }
  } else {
    datasets = Object.keys(datasetsMap).map((clusterId) => ({
      type: 'scatter',
      label: `${labelMap[clusterId] || 'Cluster'} (${clusterId})`,
      data: datasetsMap[clusterId],
      backgroundColor: palette[clusterId % palette.length],
      showLine: false
    }));

    const centroidPoints = Object.keys(centroidMap)
      .filter((id) => datasetsMap[id])
      .map((id) => ({ x: centroidMap[id].mileage, y: centroidMap[id].price }));

    if (centroidPoints.length > 0) {
      datasets.push({
        type: 'scatter',
        label: 'Centroids',
        data: centroidPoints,
        backgroundColor: '#fbbf24',
        pointStyle: 'star',
        radius: 10,
        borderColor: '#fff',
        borderWidth: 1
      });
    }
  }

  charts.clusterScatter = new Chart(ctx, {
    type: 'scatter',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: colors.text } } },
      scales: {
        x: { title: { display: true, text: 'Mileage (km)', color: colors.dim }, ticks: { color: colors.dim }, grid: { color: colors.grid } },
        y: { title: { display: true, text: 'Price (₹)', color: colors.dim }, ticks: { color: colors.dim }, grid: { color: colors.grid } }
      }
    }
  });
}

// =============================================================
// 9. Vehicle Table (favorites star + flags)
// =============================================================
// Lookup of vehicle id -> full vehicle/cluster info for the most
// recently rendered table. Used by the star button click handler
// to retrieve a full snapshot to store in favoritesMap.
let lastRenderedVehicleMap = {};

function flagsHtml(vehicle) {
  let html = '';
  if (vehicle.isGoodDeal) {
    html += `<span class="flag-badge flag-good">🔥 Good Deal (${vehicle.discountPercent}%)</span>`;
  }
  if (vehicle.isAnomaly) {
    html += `<span class="flag-badge flag-anomaly">⚠ Anomaly</span>`;
  }
  return html || '-';
}

function renderVehicleTable(vehicles, clustering) {
  elVehicleTableBody.innerHTML = '';
  lastRenderedVehicleMap = {};

  const clusterMap = {};
  if (clustering.clusters) {
    clustering.clusters.forEach((c) => { clusterMap[c.id] = c; });
  }

  const rows = vehicles.slice(0, 200);

  rows.forEach((v) => {
    const tr = document.createElement('tr');
    const info = clusterMap[v.id] || v;
    lastRenderedVehicleMap[v.id] = info;

    const clusterCell = info.clusterLabel
      ? `<span class="cluster-badge cluster-${info.clusterId}">${info.clusterLabel}</span>`
      : '-';

    const isChecked = compareList.some((c) => c.id === v.id);
    const isStarred = favoritesMap.has(v.id);

    tr.innerHTML = `
      <td><input type="checkbox" class="compare-checkbox" data-id="${v.id}" ${isChecked ? 'checked' : ''} /></td>
      <td><button class="star-btn ${isStarred ? 'starred' : ''}" data-id="${v.id}" title="Toggle favorite">${isStarred ? '★' : '☆'}</button></td>
      <td>${v.brand}</td>
      <td>${v.model}</td>
      <td>${v.fuelType}</td>
      <td>${v.year}</td>
      <td>${v.age}</td>
      <td>${formatCurrency(v.price)}</td>
      <td>${formatNumber(v.mileage)}</td>
      <td>${v.engineSize}</td>
      <td>${clusterCell}</td>
      <td>${flagsHtml(info)}</td>
    `;
    elVehicleTableBody.appendChild(tr);
  });

  if (vehicles.length === 0) {
    elVehicleTableBody.innerHTML = '<tr><td colspan="12" style="text-align:center;color:var(--text-dim);">No vehicles match the current filters.</td></tr>';
  }

  elVehicleTableBody.querySelectorAll('.star-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const vehicle = lastRenderedVehicleMap[btn.dataset.id];
      if (vehicle) toggleFavorite(vehicle);
    });
  });
}

// =============================================================
// 10. Compare Tab (table, radar chart, best-pick recommendation)
// =============================================================
document.getElementById('addCompareBtn').addEventListener('click', () => {
  const checkboxes = document.querySelectorAll('.compare-checkbox:checked');
  checkboxes.forEach((cb) => {
    const id = cb.dataset.id;
    if (!compareList.some((c) => c.id === id)) {
      const vehicle = currentVehicles.find((v) => v.id === id) ||
                       allVehiclesUnfiltered.find((v) => v.id === id);
      if (vehicle) compareList.push(vehicle);
    }
  });
  renderCompareTable();
});

function removeFromCompare(id) {
  compareList = compareList.filter((v) => v.id !== id);
  renderCompareTable();
  renderVehicleTable(getTableDisplayVehicles(), currentClustering);
}

function renderCompareTable() {
  if (compareList.length === 0) {
    elCompareContent.innerHTML = '<p class="compare-empty">No vehicles selected for comparison yet.</p>';
    elCompareChartsWrapper.style.display = 'none';
    destroyChart('compareRadar');
    return;
  }

  const clusterMap = {};
  if (currentClustering.clusters) {
    currentClustering.clusters.forEach((c) => { clusterMap[c.id] = c; });
  }

  const rows = [
    { key: 'brand', label: 'Brand' },
    { key: 'model', label: 'Model' },
    { key: 'fuelType', label: 'Fuel Type' },
    { key: 'year', label: 'Year' },
    { key: 'age', label: 'Age (yrs)' },
    { key: 'price', label: 'Price', format: formatCurrency },
    { key: 'mileage', label: 'Mileage (km)', format: formatNumber },
    { key: 'engineSize', label: 'Engine Size (L)' },
    { key: 'cluster', label: 'Segment' },
    { key: 'flags', label: 'Flags' },
    { key: 'remove', label: '' }
  ];

  let html = '<div class="compare-table-wrapper"><table class="compare-table"><tbody>';

  rows.forEach((row) => {
    html += `<tr><th>${row.label}</th>`;
    compareList.forEach((v) => {
      let cellValue;
      const info = clusterMap[v.id] || v;
      if (row.key === 'cluster') {
        cellValue = info.clusterLabel
          ? `<span class="cluster-badge cluster-${info.clusterId}">${info.clusterLabel}</span>`
          : '-';
      } else if (row.key === 'flags') {
        cellValue = flagsHtml(info);
      } else if (row.key === 'remove') {
        cellValue = `<button class="remove-compare-btn" data-id="${v.id}">Remove</button>`;
      } else {
        const raw = v[row.key];
        cellValue = row.format ? row.format(raw) : raw;
      }
      html += `<td class="compare-card">${cellValue}</td>`;
    });
    html += '</tr>';
  });

  html += '</tbody></table></div>';
  elCompareContent.innerHTML = html;

  elCompareContent.querySelectorAll('.remove-compare-btn').forEach((btn) => {
    btn.addEventListener('click', () => removeFromCompare(btn.dataset.id));
  });

  elCompareChartsWrapper.style.display = 'grid';
  renderCompareRadarChart();
  renderBestPick();
}

function renderCompareRadarChart() {
  const ctx = document.getElementById('compareRadarChart');
  destroyChart('compareRadar');
  const colors = getChartColors();

  const dataset = allVehiclesUnfiltered.length > 0 ? allVehiclesUnfiltered : compareList;
  const ranges = {};
  ['price', 'mileage', 'engineSize', 'age'].forEach((key) => {
    const values = dataset.map((v) => v[key]);
    ranges[key] = { min: Math.min(...values), max: Math.max(...values) };
  });

  const normalize = (val, key) => {
    const { min, max } = ranges[key];
    if (max === min) return 50;
    return ((val - min) / (max - min)) * 100;
  };

  const palette = ['#3b82f6', '#34d399', '#fbbf24', '#f472b6', '#a78bfa'];

  const datasets = compareList.map((v, idx) => ({
    label: `${v.brand} ${v.model}`,
    data: [
      normalize(v.price, 'price'),
      normalize(v.mileage, 'mileage'),
      normalize(v.engineSize, 'engineSize'),
      normalize(v.age, 'age')
    ],
    borderColor: palette[idx % palette.length],
    backgroundColor: palette[idx % palette.length] + '33',
    pointRadius: 3
  }));

  charts.compareRadar = new Chart(ctx, {
    type: 'radar',
    data: {
      labels: ['Price', 'Mileage', 'Engine Size', 'Age'],
      datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { color: colors.text } } },
      scales: {
        r: {
          angleLines: { color: colors.grid },
          grid: { color: colors.grid },
          pointLabels: { color: colors.text },
          ticks: { color: colors.dim, backdropColor: 'transparent' },
          suggestedMin: 0,
          suggestedMax: 100
        }
      }
    }
  });
}

function renderBestPick() {
  if (compareList.length < 2) {
    elBestPickCard.innerHTML = '<p class="compare-empty">Add at least 2 vehicles to get a recommendation.</p>';
    return;
  }

  const ranges = {};
  ['price', 'mileage', 'age'].forEach((key) => {
    const values = compareList.map((v) => v[key]);
    ranges[key] = { min: Math.min(...values), max: Math.max(...values) };
  });

  const normalize = (val, key) => {
    const { min, max } = ranges[key];
    if (max === min) return 0;
    return (val - min) / (max - min);
  };

  let best = null;
  let bestScore = -Infinity;

  compareList.forEach((v) => {
    const score =
      0.4 * (1 - normalize(v.price, 'price')) +
      0.3 * (1 - normalize(v.mileage, 'mileage')) +
      0.3 * (1 - normalize(v.age, 'age'));
    if (score > bestScore) {
      bestScore = score;
      best = v;
    }
  });

  elBestPickCard.innerHTML = `
    <h4>🏆 Best Pick: ${best.brand} ${best.model}</h4>
    <div>Price: ${formatCurrency(best.price)}</div>
    <div>Mileage: ${formatNumber(best.mileage)} km</div>
    <div>Age: ${best.age} years</div>
    <ul>
      <li>Scoring favors lower price, lower mileage, and lower age</li>
      <li>Weights: 40% price, 30% mileage, 30% age</li>
    </ul>
  `;
}

// =============================================================
// 11. Price Prediction Tab
// =============================================================
document.getElementById('predictBtn').addEventListener('click', async () => {
  const brand = elPredictBrand.value;
  const mileage = document.getElementById('predictMileage').value;
  const age = document.getElementById('predictAge').value;
  const engineSize = document.getElementById('predictEngineSize').value;
  const askingPrice = document.getElementById('predictAskingPrice').value;

  if (!brand || mileage === '' || age === '' || engineSize === '') {
    elPredictResult.innerHTML = '<p class="account-message error">Please fill in brand, mileage, age, and engine size.</p>';
    return;
  }

  try {
    const res = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brand, mileage, age, engineSize })
    });
    const data = await res.json();

    if (!res.ok) {
      elPredictResult.innerHTML = `<p class="account-message error">${data.error}</p>`;
      return;
    }

    let verdictHtml = '';
    if (askingPrice !== '') {
      const diffPercent = Math.round(((Number(askingPrice) - data.predictedPrice) / data.predictedPrice) * 100);
      if (diffPercent <= -10) {
        verdictHtml = `<span class="predict-verdict verdict-good">Good Deal - ${Math.abs(diffPercent)}% below fair price</span>`;
      } else if (diffPercent >= 10) {
        verdictHtml = `<span class="predict-verdict verdict-bad">Overpriced - ${diffPercent}% above fair price</span>`;
      } else {
        verdictHtml = `<span class="predict-verdict verdict-fair">Fairly Priced (within 10% of estimate)</span>`;
      }
    }

    elPredictResult.innerHTML = `
      <div class="predict-result-card">
        <div>Estimated Fair Price for a ${age}-year-old ${brand} (${formatNumber(mileage)} km, ${engineSize}L)</div>
        <div class="predicted-price">${formatCurrency(data.predictedPrice)}</div>
        ${askingPrice !== '' ? `<div>Your Asking Price: ${formatCurrency(askingPrice)}</div>${verdictHtml}` : ''}
      </div>
    `;
  } catch (err) {
    elPredictResult.innerHTML = '<p class="account-message error">Error contacting prediction service.</p>';
    console.error(err);
  }
});

// =============================================================
// 12. Best Deals Tab
// =============================================================
function renderDealsTable() {
  const deals = [...allVehiclesUnfiltered]
    .filter((v) => v.isGoodDeal)
    .sort((a, b) => b.discountPercent - a.discountPercent)
    .slice(0, 50);

  elDealsTableBody.innerHTML = '';

  if (deals.length === 0) {
    elDealsTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);">No good deals found in the current dataset.</td></tr>';
    return;
  }

  deals.forEach((v) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${v.brand}</td>
      <td>${v.model}</td>
      <td>${v.fuelType}</td>
      <td>${formatCurrency(v.price)}</td>
      <td>${formatCurrency(v.clusterAvgPrice)}</td>
      <td><span class="flag-badge flag-good">-${v.discountPercent}%</span></td>
      <td><span class="cluster-badge cluster-${v.clusterId}">${v.clusterLabel}</span></td>
    `;
    elDealsTableBody.appendChild(tr);
  });
}

// =============================================================
// 13. Favorites Tab (persisted snapshots, survive refresh)
// =============================================================
/**
 * Toggles a vehicle's favorite status. `vehicle` is a full
 * snapshot object (including clusterId/clusterLabel/flags), which
 * is stored as-is so the Favorites tab keeps showing it even after
 * the dataset refreshes and IDs change.
 */
async function toggleFavorite(vehicle) {
  let added;
  if (favoritesMap.has(vehicle.id)) {
    favoritesMap.delete(vehicle.id);
    added = false;
  } else {
    favoritesMap.set(vehicle.id, vehicle);
    added = true;
  }

  if (added) {
    showToast(`⭐ ${vehicle.brand} ${vehicle.model} added to favorites`);
  }

  // Persist server-side if logged in (stores the full snapshot too)
  if (currentUser) {
    try {
      const res = await fetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vehicle })
      });
      const data = await res.json();
      if (data.favorites) {
        favoritesMap = new Map(data.favorites.map((v) => [v.id, v]));
      }
    } catch (err) {
      console.error('Error saving favorite:', err);
    }
  }

  renderVehicleTable(getTableDisplayVehicles(), currentClustering);
  if (document.getElementById('tab-favorites').classList.contains('active')) {
    renderFavoritesTable();
  }
}

function renderFavoritesTable() {
  const favoriteVehicles = [...favoritesMap.values()];

  elFavoritesTableBody.innerHTML = '';

  if (favoriteVehicles.length === 0) {
    elFavoritesTableBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text-dim);">No favorites yet.</td></tr>';
  } else {
    favoriteVehicles.forEach((v) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${v.brand}</td>
        <td>${v.model}</td>
        <td>${v.fuelType}</td>
        <td>${formatCurrency(v.price)}</td>
        <td>${formatNumber(v.mileage)}</td>
        <td>${v.clusterLabel ? `<span class="cluster-badge cluster-${v.clusterId}">${v.clusterLabel}</span>` : '-'}</td>
        <td><button class="remove-compare-btn" data-id="${v.id}">Remove</button></td>
      `;
      elFavoritesTableBody.appendChild(tr);
    });

    elFavoritesTableBody.querySelectorAll('.remove-compare-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const vehicle = favoritesMap.get(btn.dataset.id);
        if (vehicle) toggleFavorite(vehicle);
      });
    });
  }

  elFavoritesSubtitle.textContent = currentUser
    ? `Logged in as ${currentUser}. Your favorites are saved on the server and persist across refreshes.`
    : 'Star vehicles in the "Search & Filter" tab to add them here. Log in to keep your favorites saved on the server.';
}

// =============================================================
// 14. Toast notifications
// =============================================================
function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  elToastContainer.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// =============================================================
// 15. Login / Register modals + profile dropdown
// =============================================================
const elLoginOpenBtn = document.getElementById('loginOpenBtn');
const elProfileArea = document.getElementById('profileArea');
const elProfileBtn = document.getElementById('profileBtn');
const elProfileDropdown = document.getElementById('profileDropdown');
const elProfileUsername = document.getElementById('profileUsername');
const elLogoutBtn = document.getElementById('logoutBtn');

const elLoginModalOverlay = document.getElementById('loginModalOverlay');
const elRegisterModalOverlay = document.getElementById('registerModalOverlay');
const elLoginModalMessage = document.getElementById('loginModalMessage');
const elRegisterModalMessage = document.getElementById('registerModalMessage');

function openModal(overlay) {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.remove('open'));
  overlay.classList.add('open');
}

function closeModals() {
  document.querySelectorAll('.modal-overlay').forEach((o) => o.classList.remove('open'));
}

function updateAuthUI() {
  if (currentUser) {
    elLoginOpenBtn.style.display = 'none';
    elProfileArea.style.display = 'block';
    elProfileUsername.textContent = currentUser;
  } else {
    elLoginOpenBtn.style.display = 'inline-block';
    elProfileArea.style.display = 'none';
    elProfileDropdown.classList.remove('open');
  }
}

function showModalMessage(el, message, isError) {
  el.textContent = message;
  el.className = 'account-message ' + (isError ? 'error' : 'success');
}

elLoginOpenBtn.addEventListener('click', () => {
  elLoginModalMessage.textContent = '';
  openModal(elLoginModalOverlay);
});

document.getElementById('loginModalClose').addEventListener('click', closeModals);
document.getElementById('registerModalClose').addEventListener('click', closeModals);

[elLoginModalOverlay, elRegisterModalOverlay].forEach((overlay) => {
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModals();
  });
});

document.getElementById('switchToRegister').addEventListener('click', (e) => {
  e.preventDefault();
  elRegisterModalMessage.textContent = '';
  openModal(elRegisterModalOverlay);
});

document.getElementById('switchToLogin').addEventListener('click', (e) => {
  e.preventDefault();
  elLoginModalMessage.textContent = '';
  openModal(elLoginModalOverlay);
});

elProfileBtn.addEventListener('click', () => {
  elProfileDropdown.classList.toggle('open');
});

document.addEventListener('click', (e) => {
  if (!elProfileArea.contains(e.target)) {
    elProfileDropdown.classList.remove('open');
  }
});

/**
 * After a successful login/register, sync favoritesMap with the
 * server's stored snapshots (merging in any local favorites that
 * weren't yet persisted).
 */
function syncFavoritesFromServer(serverFavorites) {
  const merged = new Map(favoritesMap);
  (serverFavorites || []).forEach((v) => merged.set(v.id, v));
  favoritesMap = merged;
}

document.getElementById('modalLoginBtn').addEventListener('click', async () => {
  const username = document.getElementById('modalLoginUsername').value.trim();
  const password = document.getElementById('modalLoginPassword').value;

  if (!username || !password) {
    showModalMessage(elLoginModalMessage, 'Please enter a username and password.', true);
    return;
  }

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      loginFailCount++;
      if (loginFailCount >= MAX_LOGIN_ATTEMPTS) {
        showModalMessage(
          elRegisterModalMessage,
          `Too many failed login attempts (${MAX_LOGIN_ATTEMPTS}). Please create an account below.`,
          true
        );
        loginFailCount = 0;
        openModal(elRegisterModalOverlay);
      } else {
        showModalMessage(
          elLoginModalMessage,
          `${data.error} (attempt ${loginFailCount}/${MAX_LOGIN_ATTEMPTS})`,
          true
        );
      }
      return;
    }

    loginFailCount = 0;
    currentUser = data.username;
    syncFavoritesFromServer(data.favorites);
    updateAuthUI();
    closeModals();
    showToast(`Welcome back, ${currentUser}!`);
    renderVehicleTable(getTableDisplayVehicles(), currentClustering);
    renderFavoritesTable();
  } catch (err) {
    showModalMessage(elLoginModalMessage, 'Login failed. Please try again.', true);
    console.error(err);
  }
});

document.getElementById('modalRegisterBtn').addEventListener('click', async () => {
  const username = document.getElementById('modalRegisterUsername').value.trim();
  const password = document.getElementById('modalRegisterPassword').value;

  if (!username || !password) {
    showModalMessage(elRegisterModalMessage, 'Please enter a username and password.', true);
    return;
  }

  try {
    const res = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      showModalMessage(elRegisterModalMessage, data.error, true);
      return;
    }

    loginFailCount = 0;
    currentUser = data.username;
    syncFavoritesFromServer(data.favorites);
    updateAuthUI();
    closeModals();
    showToast(`Account created. Welcome, ${currentUser}!`);
    renderVehicleTable(getTableDisplayVehicles(), currentClustering);
    renderFavoritesTable();
  } catch (err) {
    showModalMessage(elRegisterModalMessage, 'Registration failed. Please try again.', true);
    console.error(err);
  }
});

elLogoutBtn.addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {
    console.error(err);
  }
  currentUser = null;
  updateAuthUI();
  showToast('Logged out');
  renderVehicleTable(getTableDisplayVehicles(), currentClustering);
  renderFavoritesTable();
});

// On page load, check if a session is already active
fetch('/api/me')
  .then((res) => res.json())
  .then((data) => {
    if (data.username) {
      currentUser = data.username;
      syncFavoritesFromServer(data.favorites);
      updateAuthUI();
      renderVehicleTable(getTableDisplayVehicles(), currentClustering);
      renderFavoritesTable();
    }
  })
  .catch((err) => console.error('Error checking session:', err));