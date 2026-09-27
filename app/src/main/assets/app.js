const RANGE_METERS = 100;
const MAX_OBSERVATIONS_PER_ROUTER = 24;
const CLOUD_GRID_RADIUS_METERS = 100;
const CLOUD_GRID_STEP_METERS = 12.5;
const CLOUD_RENDER_CELLS = 28;
const RSSI_AT_ONE_METER = -45;
const PATH_LOSS_EXPONENT = 2.6;

const statusEl = document.getElementById('status');

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  doubleClickZoom: false,
  scrollWheelZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false
});

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20
}).addTo(map);

map.createPane('wifiClouds');
map.getPane('wifiClouds').style.zIndex = 430;

const deviceIcon = L.divIcon({
  className: '',
  html: '<div class="device-marker"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

let deviceMarker = null;
let accuracyRing = null;
let rangeRing = null;
let hasInitialFix = false;
let deviceLocation = null;

const routers = new Map();

function fitToRange(latlng) {
  const bounds = L.latLng(latlng.lat, latlng.lng).toBounds(RANGE_METERS * 2);
  map.fitBounds(bounds, { padding: [8, 8], animate: false });
}

function updateLocation(latitude, longitude, accuracy) {
  const latlng = L.latLng(latitude, longitude);
  deviceLocation = { latitude, longitude, accuracy: Number(accuracy) || 1 };

  if (!deviceMarker) {
    deviceMarker = L.marker(latlng, { icon: deviceIcon, interactive: false }).addTo(map);
    rangeRing = L.circle(latlng, {
      radius: RANGE_METERS,
      className: 'range-ring',
      interactive: false
    }).addTo(map);
    accuracyRing = L.circle(latlng, {
      radius: Math.max(1, accuracy || 1),
      className: 'accuracy-ring',
      interactive: false
    }).addTo(map);
  } else {
    deviceMarker.setLatLng(latlng);
    rangeRing.setLatLng(latlng);
    accuracyRing.setLatLng(latlng).setRadius(Math.max(1, accuracy || 1));
  }

  if (!hasInitialFix) {
    fitToRange(latlng);
    hasInitialFix = true;
  } else {
    map.panTo(latlng, { animate: true, duration: 0.35, noMoveStart: true });
  }

  statusEl.textContent = accuracy
    ? `±${Math.round(accuracy)} m`
    : 'Location active';
}

function metersPerDegreeLat() {
  return 111320;
}

function metersPerDegreeLng(latitude) {
  return 111320 * Math.cos(latitude * Math.PI / 180);
}

function offsetLatLng(latitude, longitude, eastMeters, northMeters) {
  return {
    lat: latitude + northMeters / metersPerDegreeLat(),
    lng: longitude + eastMeters / metersPerDegreeLng(latitude)
  };
}

function distanceMeters(aLat, aLng, bLat, bLng) {
  const meanLat = (aLat + bLat) * 0.5;
  const north = (bLat - aLat) * metersPerDegreeLat();
  const east = (bLng - aLng) * metersPerDegreeLng(meanLat);
  return Math.hypot(east, north);
}

function estimatedRangeFromRssi(rssi) {
  const meters = Math.pow(10, (RSSI_AT_ONE_METER - Number(rssi)) / (10 * PATH_LOSS_EXPONENT));
  return Math.max(1, Math.min(150, meters));
}

function observationWeight(observation, newestTimestamp) {
  const ageSeconds = Math.max(0, (newestTimestamp - observation.timestamp) / 1000);
  const recency = Math.exp(-ageSeconds / 180);
  const gps = 1 / Math.max(4, Number(observation.accuracy) || 25);
  const signal = Math.max(0.2, Math.min(1, (Number(observation.rssi) + 100) / 55));
  return recency * gps * signal;
}

function weightedObservationCenter(observations) {
  const newest = Math.max(...observations.map(o => o.timestamp));
  let lat = 0;
  let lng = 0;
  let weightSum = 0;

  observations.forEach(observation => {
    const weight = observationWeight(observation, newest);
    lat += observation.latitude * weight;
    lng += observation.longitude * weight;
    weightSum += weight;
  });

  if (!weightSum) {
    const last = observations[observations.length - 1];
    return { latitude: last.latitude, longitude: last.longitude };
  }

  return { latitude: lat / weightSum, longitude: lng / weightSum };
}

function buildProbabilityField(observations) {
  if (!observations.length) return { cells: [], confidence: 0 };

  const center = weightedObservationCenter(observations);
  const newest = Math.max(...observations.map(o => o.timestamp));
  const cells = [];

  for (let north = -CLOUD_GRID_RADIUS_METERS; north <= CLOUD_GRID_RADIUS_METERS; north += CLOUD_GRID_STEP_METERS) {
    for (let east = -CLOUD_GRID_RADIUS_METERS; east <= CLOUD_GRID_RADIUS_METERS; east += CLOUD_GRID_STEP_METERS) {
      const candidate = offsetLatLng(center.latitude, center.longitude, east, north);
      let logLikelihood = 0;
      let totalWeight = 0;

      observations.forEach(observation => {
        const expectedRange = estimatedRangeFromRssi(observation.rssi);
        const actualRange = distanceMeters(
          observation.latitude,
          observation.longitude,
          candidate.lat,
          candidate.lng
        );
        const sigma = Math.max(10, expectedRange * 0.45, Number(observation.accuracy) || 10);
        const residual = actualRange - expectedRange;
        const weight = observationWeight(observation, newest);
        logLikelihood += weight * -0.5 * Math.pow(residual / sigma, 2);
        totalWeight += weight;
      });

      cells.push({
        lat: candidate.lat,
        lng: candidate.lng,
        logLikelihood: totalWeight ? logLikelihood / totalWeight : -Infinity
      });
    }
  }

  const maxLog = Math.max(...cells.map(cell => cell.logLikelihood));
  cells.forEach(cell => {
    cell.probability = Number.isFinite(cell.logLikelihood)
      ? Math.exp(cell.logLikelihood - maxLog)
      : 0;
  });

  const probabilitySum = cells.reduce((sum, cell) => sum + cell.probability, 0) || 1;
  cells.forEach(cell => {
    cell.probability /= probabilitySum;
  });

  cells.sort((a, b) => b.probability - a.probability);

  const spatialSpread = observations.length > 1
    ? Math.max(...observations.map(o => distanceMeters(center.latitude, center.longitude, o.latitude, o.longitude)))
    : 0;
  const countConfidence = Math.min(1, observations.length / 10);
  const geometryConfidence = Math.min(1, spatialSpread / 35);
  const confidence = Math.max(0.12, Math.min(1, 0.25 + countConfidence * 0.45 + geometryConfidence * 0.30));

  return {
    cells: cells.slice(0, CLOUD_RENDER_CELLS),
    confidence
  };
}

function cloudCellIcon(probability, confidence) {
  const alpha = Math.max(0.03, Math.min(0.9, probability * 18 * confidence));
  const size = 42;
  return L.divIcon({
    className: '',
    html: `<div class="wifi-cloud-cell" style="opacity:${alpha}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function renderRouter(router) {
  const field = buildProbabilityField(router.observations);
  router.confidence = field.confidence;

  if (router.layer) {
    router.layer.clearLayers();
  } else {
    router.layer = L.layerGroup().addTo(map);
  }

  field.cells.forEach(cell => {
    const marker = L.marker([cell.lat, cell.lng], {
      pane: 'wifiClouds',
      icon: cloudCellIcon(cell.probability, field.confidence),
      interactive: false,
      zIndexOffset: Math.round(field.confidence * 1000)
    });
    router.layer.addLayer(marker);
  });
}

function ingestWifiScan(observations) {
  if (!Array.isArray(observations)) return;

  const touched = new Set();

  observations.forEach(raw => {
    const bssid = String(raw.bssid || '').toLowerCase();
    if (!bssid) return;

    let router = routers.get(bssid);
    if (!router) {
      router = {
        bssid,
        ssid: String(raw.ssid || ''),
        observations: [],
        confidence: 0,
        layer: null
      };
      routers.set(bssid, router);
    }

    router.ssid = String(raw.ssid || router.ssid || '');
    router.observations.push({
      bssid,
      ssid: router.ssid,
      rssi: Number(raw.rssi),
      frequency: Number(raw.frequency),
      timestamp: Number(raw.timestamp) || Date.now(),
      latitude: Number(raw.latitude),
      longitude: Number(raw.longitude),
      accuracy: Number(raw.accuracy) || 25
    });

    if (router.observations.length > MAX_OBSERVATIONS_PER_ROUTER) {
      router.observations.splice(0, router.observations.length - MAX_OBSERVATIONS_PER_ROUTER);
    }

    touched.add(bssid);
  });

  touched.forEach(bssid => renderRouter(routers.get(bssid)));

  const visible = [...routers.values()].filter(router => router.layer).length;
  if (visible) statusEl.textContent = `${visible} Wi-Fi targets`;
}

window.Tricorder = {
  onLocation(latitude, longitude, accuracy) {
    updateLocation(Number(latitude), Number(longitude), Number(accuracy));
  },
  onWifiScan(observations) {
    ingestWifiScan(observations);
  },
  onStatus(message) {
    statusEl.textContent = message;
  }
};
