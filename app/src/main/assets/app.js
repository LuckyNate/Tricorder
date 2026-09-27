const RADAR_MARGIN_PX = 12;
const RANGE_OPTIONS = [10, 50, 100, 500, 1000];
const MAX_OBSERVATIONS_PER_ROUTER = 24;
const SOLVER_STEP_METERS = 8;
const MAX_SOLVER_RADIUS_METERS = 220;
const RSSI_AT_ONE_METER = -45;
const PATH_LOSS_EXPONENT = 2.6;
const OUTER_CLOUD_MASS = 0.82;
const INNER_CLOUD_MASS = 0.48;

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

function rangeSigma(observation) {
  const expectedRange = estimatedRangeFromRssi(observation.rssi);
  return Math.max(5, expectedRange * 0.38, Number(observation.accuracy) || 10);
}

function observationWeight(observation, newestTimestamp) {
  const ageSeconds = Math.max(0, (newestTimestamp - observation.timestamp) / 1000);
  const recency = Math.exp(-ageSeconds / 300);
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

function observationSpread(observations) {
  if (observations.length < 2) return 0;
  let maxDistance = 0;
  for (let i = 0; i < observations.length; i += 1) {
    for (let j = i + 1; j < observations.length; j += 1) {
      maxDistance = Math.max(
        maxDistance,
        distanceMeters(
          observations[i].latitude,
          observations[i].longitude,
          observations[j].latitude,
          observations[j].longitude
        )
      );
    }
  }
  return maxDistance;
}

function ringPoints(latitude, longitude, radius, segments = 72) {
  const points = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push(offsetLatLng(
      latitude,
      longitude,
      Math.cos(angle) * radius,
      Math.sin(angle) * radius
    ));
  }
  return points.map(point => [point.lat, point.lng]);
}

function unresolvedCloud(observations) {
  const newest = Math.max(...observations.map(o => o.timestamp));
  let rangeTotal = 0;
  let sigmaTotal = 0;
  let weightTotal = 0;
  let latitude = 0;
  let longitude = 0;

  observations.forEach(observation => {
    const weight = observationWeight(observation, newest);
    rangeTotal += estimatedRangeFromRssi(observation.rssi) * weight;
    sigmaTotal += rangeSigma(observation) * weight;
    latitude += observation.latitude * weight;
    longitude += observation.longitude * weight;
    weightTotal += weight;
  });

  const last = observations[observations.length - 1];
  const centerLat = weightTotal ? latitude / weightTotal : last.latitude;
  const centerLng = weightTotal ? longitude / weightTotal : last.longitude;
  const expectedRange = weightTotal ? rangeTotal / weightTotal : estimatedRangeFromRssi(last.rssi);
  const sigma = weightTotal ? sigmaTotal / weightTotal : rangeSigma(last);
  const halfWidth = Math.max(6, sigma * 1.35);

  return {
    mode: 'annulus',
    centerLat,
    centerLng,
    innerRadius: Math.max(1, expectedRange - halfWidth),
    outerRadius: Math.max(4, expectedRange + halfWidth),
    confidence: Math.max(0.08, Math.min(0.28, 0.08 + observations.length * 0.025))
  };
}

function candidateCloud(observations) {
  const center = weightedObservationCenter(observations);
  const newest = Math.max(...observations.map(o => o.timestamp));
  const spread = observationSpread(observations);
  const maxExpectedRange = Math.max(...observations.map(o => estimatedRangeFromRssi(o.rssi)));
  const solverRadius = Math.min(
    MAX_SOLVER_RADIUS_METERS,
    Math.max(60, maxExpectedRange + spread * 0.65 + 24)
  );

  const candidates = [];
  let maxScore = -Infinity;

  for (let north = -solverRadius, iy = 0; north <= solverRadius; north += SOLVER_STEP_METERS, iy += 1) {
    for (let east = -solverRadius, ix = 0; east <= solverRadius; east += SOLVER_STEP_METERS, ix += 1) {
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
        const sigma = rangeSigma(observation);
        const residual = actualRange - expectedRange;
        const weight = observationWeight(observation, newest);
        logLikelihood += weight * -0.5 * Math.pow(residual / sigma, 2);
        totalWeight += weight;
      });

      const score = totalWeight ? logLikelihood / totalWeight : -Infinity;
      maxScore = Math.max(maxScore, score);
      candidates.push({
        lat: candidate.lat,
        lng: candidate.lng,
        east,
        north,
        ix,
        iy,
        score,
        probability: 0
      });
    }
  }

  let probabilityTotal = 0;
  candidates.forEach(candidate => {
    candidate.probability = Number.isFinite(candidate.score)
      ? Math.exp(candidate.score - maxScore)
      : 0;
    probabilityTotal += candidate.probability;
  });

  if (!probabilityTotal) return null;

  candidates.forEach(candidate => {
    candidate.probability /= probabilityTotal;
  });
  candidates.sort((a, b) => b.probability - a.probability);

  let rmsTotal = 0;
  let meanEast = 0;
  let meanNorth = 0;
  candidates.forEach(candidate => {
    meanEast += candidate.east * candidate.probability;
    meanNorth += candidate.north * candidate.probability;
  });
  candidates.forEach(candidate => {
    const dx = candidate.east - meanEast;
    const dy = candidate.north - meanNorth;
    rmsTotal += candidate.probability * ((dx * dx) + (dy * dy));
  });

  const rmsSpread = Math.sqrt(rmsTotal);
  const countConfidence = Math.min(1, observations.length / 12);
  const geometryConfidence = Math.min(1, spread / 45);
  const concentrationConfidence = Math.max(0, Math.min(1, 1 - rmsSpread / solverRadius));
  const confidence = Math.max(
    0.14,
    Math.min(1, 0.12 + countConfidence * 0.25 + geometryConfidence * 0.38 + concentrationConfidence * 0.25)
  );

  return {
    mode: 'field',
    center,
    candidates,
    confidence,
    solverRadius
  };
}

function solveRouterCloud(observations) {
  if (!observations.length) return null;
  const spread = observationSpread(observations);
  if (spread < 5) return unresolvedCloud(observations);
  return candidateCloud(observations) || unresolvedCloud(observations);
}

function selectedMassCells(candidates, targetMass) {
  const selected = [];
  let mass = 0;
  for (const candidate of candidates) {
    selected.push(candidate);
    mass += candidate.probability;
    if (mass >= targetMass) break;
  }
  return selected;
}

function clusterCells(cells) {
  const byKey = new Map(cells.map(cell => [`${cell.ix},${cell.iy}`, cell]));
  const visited = new Set();
  const clusters = [];

  cells.forEach(cell => {
    const startKey = `${cell.ix},${cell.iy}`;
    if (visited.has(startKey)) return;

    const cluster = [];
    const queue = [cell];
    visited.add(startKey);

    while (queue.length) {
      const current = queue.pop();
      cluster.push(current);

      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          if (dx === 0 && dy === 0) continue;
          const key = `${current.ix + dx},${current.iy + dy}`;
          if (!visited.has(key) && byKey.has(key)) {
            visited.add(key);
            queue.push(byKey.get(key));
          }
        }
      }
    }

    clusters.push(cluster);
  });

  return clusters;
}

function cross(o, a, b) {
  return (a.east - o.east) * (b.north - o.north) -
    (a.north - o.north) * (b.east - o.east);
}

function convexHull(points) {
  if (points.length <= 2) return points.slice();
  const sorted = points.slice().sort((a, b) => a.east - b.east || a.north - b.north);
  const lower = [];
  sorted.forEach(point => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  });

  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function clearRouterLayer(router) {
  if (router.layer) {
    map.removeLayer(router.layer);
    router.layer = null;
  }
  router.visualLayers = [];
}

function addAnnulusLayers(layers, cloud) {
  const outer = ringPoints(cloud.centerLat, cloud.centerLng, cloud.outerRadius);
  const inner = ringPoints(cloud.centerLat, cloud.centerLng, cloud.innerRadius).reverse();
  layers.push(L.polygon([outer, inner], {
    pane: 'wifiClouds',
    stroke: false,
    fillColor: '#78b4ff',
    fillOpacity: 0.09 + cloud.confidence * 0.12,
    fillRule: 'evenodd',
    interactive: false
  }));
}

function addFieldMassLayers(layers, field, targetMass, opacity) {
  const selected = selectedMassCells(field.candidates, targetMass);
  const clusters = clusterCells(selected);

  clusters.forEach(cluster => {
    if (cluster.length < 3) {
      cluster.forEach(cell => {
        layers.push(L.circle([cell.lat, cell.lng], {
          pane: 'wifiClouds',
          radius: SOLVER_STEP_METERS * 0.9,
          stroke: false,
          fillColor: '#78b4ff',
          fillOpacity: opacity,
          interactive: false
        }));
      });
      return;
    }

    const hull = convexHull(cluster);
    if (hull.length < 3) return;
    layers.push(L.polygon(hull.map(cell => [cell.lat, cell.lng]), {
      pane: 'wifiClouds',
      stroke: false,
      fillColor: '#78b4ff',
      fillOpacity: opacity,
      smoothFactor: 1.4,
      interactive: false
    }));
  });
}

function renderRouter(router) {
  const cloud = solveRouterCloud(router.observations);
  if (!cloud) return;

  router.cloud = cloud;
  router.confidence = cloud.confidence;
  clearRouterLayer(router);

  const layers = [];
  if (cloud.mode === 'annulus') {
    addAnnulusLayers(layers, cloud);
  } else {
    addFieldMassLayers(layers, cloud, OUTER_CLOUD_MASS, 0.055 + cloud.confidence * 0.09);
    addFieldMassLayers(layers, cloud, INNER_CLOUD_MASS, 0.10 + cloud.confidence * 0.18);

    if (cloud.confidence >= 0.68 && cloud.candidates.length) {
      const best = cloud.candidates[0];
      layers.push(L.circleMarker([best.lat, best.lng], {
        pane: 'wifiClouds',
        radius: 2.5 + cloud.confidence * 2,
        stroke: false,
        fillColor: '#c8e1ff',
        fillOpacity: 0.35 + cloud.confidence * 0.5,
        interactive: false
      }));
    }
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
        cloud: null,
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