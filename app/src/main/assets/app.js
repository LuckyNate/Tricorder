const RADAR_MARGIN_PX = 12;
const RANGE_OPTIONS = [10, 50, 100, 500, 1000];
const MAX_OBSERVATIONS_PER_ROUTER = 24;
const SOLVER_RADIUS_METERS = 120;
const SOLVER_STEP_METERS = 8;
const RSSI_AT_ONE_METER = -45;
const PATH_LOSS_EXPONENT = 2.6;

const statusEl = document.getElementById('status');
const rangeEl = document.getElementById('range');
const modeToggle = document.getElementById('modeToggle');
const mode2d = document.getElementById('mode2d');
const mode3d = document.getElementById('mode3d');

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  doubleClickZoom: false,
  scrollWheelZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false,
  zoomSnap: 0.01,
  zoomDelta: 0.25
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
let currentMode = '2d';
let currentRangeMeters = RANGE_OPTIONS[0];

const routers = new Map();

function rangeLabel(meters) {
  return meters >= 1000
    ? `${meters / 1000} km radius`
    : `${meters} m radius`;
}

function fitToRange(latlng) {
  const container = map.getContainer();
  const width = container.clientWidth;
  const height = container.clientHeight;
  if (!width || !height) return;

  const usableDiameter = Math.max(1, Math.min(width, height) - (RADAR_MARGIN_PX * 2));
  const padX = Math.max(RADAR_MARGIN_PX, (width - usableDiameter) / 2);
  const padY = Math.max(RADAR_MARGIN_PX, (height - usableDiameter) / 2);
  const bounds = L.latLng(latlng.lat, latlng.lng).toBounds(currentRangeMeters * 2);

  map.fitBounds(bounds, {
    paddingTopLeft: [padX, padY],
    paddingBottomRight: [padX, padY],
    animate: false
  });
}

function refitRadar() {
  if (currentMode !== '2d' || !deviceLocation) return;
  map.invalidateSize(false);
  fitToRange(L.latLng(deviceLocation.latitude, deviceLocation.longitude));
}

function setRange(meters) {
  currentRangeMeters = RANGE_OPTIONS.includes(meters) ? meters : RANGE_OPTIONS[0];
  rangeEl.textContent = rangeLabel(currentRangeMeters);
  rangeEl.setAttribute('aria-label', `Radar range ${rangeLabel(currentRangeMeters)}. Tap to change.`);

  if (rangeRing) rangeRing.setRadius(currentRangeMeters);
  requestAnimationFrame(refitRadar);
}

function toggleRange() {
  const index = RANGE_OPTIONS.indexOf(currentRangeMeters);
  const nextIndex = (index + 1) % RANGE_OPTIONS.length;
  setRange(RANGE_OPTIONS[nextIndex]);
}

function setMode(mode) {
  currentMode = mode === '3d' ? '3d' : '2d';
  const is3d = currentMode === '3d';
  document.body.classList.toggle('mode-3d', is3d);
  modeToggle.setAttribute('aria-pressed', String(is3d));
  mode3d.classList.toggle('active', is3d);
  mode2d.classList.toggle('active', !is3d);

  if (!is3d) {
    requestAnimationFrame(() => {
      map.invalidateSize(false);
      refitRadar();
    });
  }
}

rangeEl.addEventListener('click', toggleRange);
modeToggle.addEventListener('click', () => setMode(currentMode === '2d' ? '3d' : '2d'));

function updateLocation(latitude, longitude, accuracy) {
  const latlng = L.latLng(latitude, longitude);
  deviceLocation = { latitude, longitude, accuracy: Number(accuracy) || 1 };

  if (!deviceMarker) {
    deviceMarker = L.marker(latlng, { icon: deviceIcon, interactive: false }).addTo(map);
    rangeRing = L.circle(latlng, {
      radius: currentRangeMeters,
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
    rangeRing.setLatLng(latlng).setRadius(currentRangeMeters);
    accuracyRing.setLatLng(latlng).setRadius(Math.max(1, accuracy || 1));
  }

  if (currentMode === '2d') {
    if (!hasInitialFix) {
      fitToRange(latlng);
      hasInitialFix = true;
    } else {
      map.panTo(latlng, { animate: true, duration: 0.35, noMoveStart: true });
    }
  }

  statusEl.textContent = accuracy ? `±${Math.round(accuracy)} m` : 'Location active';
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
  let latitude = 0;
  let longitude = 0;
  let totalWeight = 0;

  observations.forEach(observation => {
    const weight = observationWeight(observation, newest);
    latitude += observation.latitude * weight;
    longitude += observation.longitude * weight;
    totalWeight += weight;
  });

  if (!totalWeight) {
    const last = observations[observations.length - 1];
    return { latitude: last.latitude, longitude: last.longitude };
  }

  return {
    latitude: latitude / totalWeight,
    longitude: longitude / totalWeight
  };
}

function weakEstimate(observations, center, spatialSpread) {
  const newest = Math.max(...observations.map(o => o.timestamp));
  let rangeTotal = 0;
  let accuracyTotal = 0;
  let weightTotal = 0;

  observations.forEach(observation => {
    const weight = observationWeight(observation, newest);
    rangeTotal += estimatedRangeFromRssi(observation.rssi) * weight;
    accuracyTotal += (Number(observation.accuracy) || 25) * weight;
    weightTotal += weight;
  });

  const meanRange = weightTotal ? rangeTotal / weightTotal : 50;
  const meanAccuracy = weightTotal ? accuracyTotal / weightTotal : 25;
  const countConfidence = Math.min(1, observations.length / 8);
  const geometryConfidence = Math.min(1, spatialSpread / 35);
  const confidence = Math.max(0.08, Math.min(0.32, 0.08 + countConfidence * 0.12 + geometryConfidence * 0.12));

  return {
    latitude: center.latitude,
    longitude: center.longitude,
    uncertainty: Math.max(18, Math.min(180, meanRange + meanAccuracy)),
    confidence
  };
}

function solveRouterEstimate(observations) {
  if (!observations.length) return null;

  const center = weightedObservationCenter(observations);
  const newest = Math.max(...observations.map(o => o.timestamp));
  const spatialSpread = observations.length > 1
    ? Math.max(...observations.map(o => distanceMeters(center.latitude, center.longitude, o.latitude, o.longitude)))
    : 0;

  if (observations.length < 3 || spatialSpread < 8) {
    return weakEstimate(observations, center, spatialSpread);
  }

  const candidates = [];
  for (let north = -SOLVER_RADIUS_METERS; north <= SOLVER_RADIUS_METERS; north += SOLVER_STEP_METERS) {
    for (let east = -SOLVER_RADIUS_METERS; east <= SOLVER_RADIUS_METERS; east += SOLVER_STEP_METERS) {
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
        const sigma = Math.max(8, expectedRange * 0.42, Number(observation.accuracy) || 10);
        const residual = actualRange - expectedRange;
        const weight = observationWeight(observation, newest);
        logLikelihood += weight * -0.5 * Math.pow(residual / sigma, 2);
        totalWeight += weight;
      });

      candidates.push({
        lat: candidate.lat,
        lng: candidate.lng,
        score: totalWeight ? logLikelihood / totalWeight : -Infinity
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const peak = candidates[0];
  const maxScore = peak.score;
  let probabilityTotal = 0;
  let spreadTotal = 0;

  candidates.forEach(candidate => {
    const probability = Number.isFinite(candidate.score) ? Math.exp(candidate.score - maxScore) : 0;
    candidate.probability = probability;
    probabilityTotal += probability;
    spreadTotal += probability * Math.pow(
      distanceMeters(peak.lat, peak.lng, candidate.lat, candidate.lng),
      2
    );
  });

  const rmsSpread = probabilityTotal ? Math.sqrt(spreadTotal / probabilityTotal) : SOLVER_RADIUS_METERS;
  const uncertainty = Math.max(6, Math.min(160, rmsSpread));
  const countConfidence = Math.min(1, observations.length / 10);
  const geometryConfidence = Math.min(1, spatialSpread / 45);
  const concentrationConfidence = Math.max(0, Math.min(1, 1 - uncertainty / SOLVER_RADIUS_METERS));
  const confidence = Math.max(
    0.15,
    Math.min(1, 0.18 + countConfidence * 0.28 + geometryConfidence * 0.28 + concentrationConfidence * 0.26)
  );

  return {
    latitude: peak.lat,
    longitude: peak.lng,
    uncertainty,
    confidence
  };
}

function stabilizeEstimate(previous, next) {
  if (!previous) return next;

  const movement = distanceMeters(previous.latitude, previous.longitude, next.latitude, next.longitude);
  const meaningfulShift = movement > Math.max(4, previous.uncertainty * 0.15);
  const alpha = meaningfulShift
    ? 0.3 + next.confidence * 0.5
    : 0.18 + next.confidence * 0.25;

  return {
    latitude: previous.latitude + (next.latitude - previous.latitude) * alpha,
    longitude: previous.longitude + (next.longitude - previous.longitude) * alpha,
    uncertainty: previous.uncertainty + (next.uncertainty - previous.uncertainty) * alpha,
    confidence: previous.confidence + (next.confidence - previous.confidence) * alpha
  };
}

function clearRouterLayer(router) {
  if (router.layer) {
    map.removeLayer(router.layer);
    router.layer = null;
  }
  router.visualLayers = [];
}

function renderRouter(router) {
  const solved = solveRouterEstimate(router.observations);
  if (!solved) return;

  router.estimate = stabilizeEstimate(router.estimate, solved);
  router.confidence = router.estimate.confidence;
  clearRouterLayer(router);

  const estimate = router.estimate;
  const center = [estimate.latitude, estimate.longitude];
  const confidence = estimate.confidence;
  const outerOpacity = 0.025 + confidence * 0.055;
  const middleOpacity = 0.04 + confidence * 0.09;
  const coreOpacity = 0.055 + confidence * 0.15;
  const layers = [];

  layers.push(L.circle(center, {
    pane: 'wifiClouds',
    radius: estimate.uncertainty,
    stroke: false,
    fillColor: '#78b4ff',
    fillOpacity: outerOpacity,
    interactive: false
  }));

  layers.push(L.circle(center, {
    pane: 'wifiClouds',
    radius: Math.max(3, estimate.uncertainty * 0.62),
    stroke: false,
    fillColor: '#78b4ff',
    fillOpacity: middleOpacity,
    interactive: false
  }));

  layers.push(L.circle(center, {
    pane: 'wifiClouds',
    radius: Math.max(2, estimate.uncertainty * 0.3),
    stroke: false,
    fillColor: '#78b4ff',
    fillOpacity: coreOpacity,
    interactive: false
  }));

  if (confidence >= 0.35) {
    layers.push(L.circleMarker(center, {
      pane: 'wifiClouds',
      radius: 2.5 + confidence * 2.5,
      stroke: false,
      fillColor: '#b9d8ff',
      fillOpacity: 0.35 + confidence * 0.55,
      interactive: false
    }));
  }

  router.visualLayers = layers;
  router.layer = L.layerGroup(layers).addTo(map);
}

function orderRouterLayers() {
  [...routers.values()]
    .filter(router => router.visualLayers?.length)
    .sort((a, b) => a.confidence - b.confidence)
    .forEach(router => {
      router.visualLayers.forEach(layer => {
        if (typeof layer.bringToFront === 'function') layer.bringToFront();
      });
    });
}

function renderAllRouters() {
  routers.forEach(router => {
    if (router.observations.length) renderRouter(router);
  });
  orderRouterLayers();
}

function ingestWifiScan(observations) {
  if (!Array.isArray(observations)) return;

  observations.forEach(raw => {
    const bssid = String(raw.bssid || '').toLowerCase();
    if (!bssid) return;

    let router = routers.get(bssid);
    if (!router) {
      router = {
        bssid,
        ssid: String(raw.ssid || ''),
        observations: [],
        estimate: null,
        confidence: 0,
        layer: null,
        visualLayers: []
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
  });

  renderAllRouters();

  const visible = [...routers.values()].filter(router => router.layer).length;
  if (visible) statusEl.textContent = `${visible} Wi-Fi targets`;
}

window.addEventListener('resize', () => requestAnimationFrame(refitRadar));

setRange(currentRangeMeters);

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
