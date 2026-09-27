const RADAR_MARGIN_PX = 12;
const RANGE_OPTIONS = [10, 50, 100, 500, 1000];
const MAX_OBSERVATIONS_PER_ROUTER = 24;
const SOLVER_STEP_METERS = 8;
const MAX_SOLVER_RADIUS_METERS = 220;
const RSSI_AT_ONE_METER = -45;
const PATH_LOSS_EXPONENT = 2.6;
const OUTER_CLOUD_MASS = 0.82;
const INNER_CLOUD_MASS = 0.48;
const RENDER_INTERVAL_MS = 1000 / 30;
const MIN_HEADING_SWEEP_DEGREES = 45;

const statusEl = document.getElementById('status');
const rangeEl = document.getElementById('range');
const modeToggle = document.getElementById('modeToggle');
const mode2d = document.getElementById('mode2d');
const mode3d = document.getElementById('mode3d');
const sensorControlsEl = document.getElementById('sensorControls');

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

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20 }).addTo(map);

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
let lastRenderTime = 0;
let currentHeading = null;
let currentHeadingAccuracy = 0;
let currentHeadingSource = 'none';

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

function bearingDegrees(aLat, aLng, bLat, bLng) {
  const meanLat = (aLat + bLat) * 0.5;
  const north = (bLat - aLat) * metersPerDegreeLat();
  const east = (bLng - aLng) * metersPerDegreeLng(meanLat);
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function angularDifferenceDegrees(a, b) {
  return ((a - b + 540) % 360) - 180;
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

function cross(o, a, b) {
  return (a.east - o.east) * (b.north - o.north) -
    (a.north - o.north) * (b.east - o.east);
}

function convexHull(points) {
  if (points.length <= 2) return points.slice();
  const sorted = points.slice().sort((a, b) => a.east - b.east || a.north - b.north);
  const lower = [];
  sorted.forEach(point => {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  });
  const upper = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const point = sorted[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

class ScannerSensor {
  constructor({ id, label, color, paneName, usesHeading = false }) {
    this.id = id;
    this.label = label;
    this.color = color;
    this.paneName = paneName;
    this.usesHeading = usesHeading;
    this.enabled = true;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) return;
    this.enabled = next;
    this.onVisibilityChanged(next);
    renderSensorControls();
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

  onVisibilityChanged() {}
  ingest() {}
  frame() {}
}

class WifiSensor extends ScannerSensor {
  constructor() {
    super({
      id: 'wifi',
      label: 'WI-FI SOURCE',
      color: '#78b4ff',
      paneName: 'wifiClouds',
      usesHeading: true
    });
    this.targets = new Map();
    this.dirtyTargets = new Set();
  }

  onVisibilityChanged(visible) {
    if (!visible) {
      this.targets.forEach(target => this.clearTargetLayer(target));
      return;
    }
    this.targets.forEach((target, bssid) => {
      if (target.observations.length) this.dirtyTargets.add(bssid);
    });
  }

  estimatedRangeFromRssi(rssi) {
    const meters = Math.pow(10, (RSSI_AT_ONE_METER - Number(rssi)) / (10 * PATH_LOSS_EXPONENT));
    return Math.max(1, Math.min(150, meters));
  }

  rangeSigma(observation) {
    const expectedRange = this.estimatedRangeFromRssi(observation.rssi);
    const gpsContribution = Math.min(10, (Number(observation.accuracy) || 10) * 0.3);
    return Math.max(2.5, expectedRange * 0.26, gpsContribution);
  }

  observationWeight(observation, newestTimestamp) {
    const ageSeconds = Math.max(0, (newestTimestamp - observation.timestamp) / 1000);
    const recency = Math.exp(-ageSeconds / 300);
    const gps = 1 / Math.max(4, Number(observation.accuracy) || 25);
    const signal = Math.max(0.2, Math.min(1, (Number(observation.rssi) + 100) / 55));
    return recency * gps * signal;
  }

  headingAccuracyWeight(accuracy) {
    const value = Number(accuracy) || 0;
    if (value >= 3) return 1;
    if (value === 2) return 0.75;
    if (value === 1) return 0.45;
    return 0.2;
  }

  headingObservations(observations) {
    return observations.filter(observation =>
      Number.isFinite(observation.heading) && observation.headingSource === 'orientation'
    );
  }

  headingSweepDegrees(observations) {
    const headings = this.headingObservations(observations)
      .map(observation => ((observation.heading % 360) + 360) % 360)
      .sort((a, b) => a - b);
    if (headings.length < 2) return 0;
    let largestGap = 0;
    for (let i = 0; i < headings.length; i += 1) {
      const current = headings[i];
      const next = i === headings.length - 1 ? headings[0] + 360 : headings[i + 1];
      largestGap = Math.max(largestGap, next - current);
    }
    return 360 - largestGap;
  }

  weightedObservationCenter(observations) {
    const newest = Math.max(...observations.map(o => o.timestamp));
    let latitude = 0;
    let longitude = 0;
    let totalWeight = 0;
    observations.forEach(observation => {
      const weight = this.observationWeight(observation, newest);
      latitude += observation.latitude * weight;
      longitude += observation.longitude * weight;
      totalWeight += weight;
    });
    if (!totalWeight) {
      const last = observations[observations.length - 1];
      return { latitude: last.latitude, longitude: last.longitude };
    }
    return { latitude: latitude / totalWeight, longitude: longitude / totalWeight };
  }

  observationSpread(observations) {
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

  unresolvedCloud(observations) {
    const newest = Math.max(...observations.map(o => o.timestamp));
    let rangeTotal = 0;
    let sigmaTotal = 0;
    let weightTotal = 0;
    let latitude = 0;
    let longitude = 0;

    observations.forEach(observation => {
      const weight = this.observationWeight(observation, newest);
      rangeTotal += this.estimatedRangeFromRssi(observation.rssi) * weight;
      sigmaTotal += this.rangeSigma(observation) * weight;
      latitude += observation.latitude * weight;
      longitude += observation.longitude * weight;
      weightTotal += weight;
    });

    const last = observations[observations.length - 1];
    const centerLat = weightTotal ? latitude / weightTotal : last.latitude;
    const centerLng = weightTotal ? longitude / weightTotal : last.longitude;
    const expectedRange = weightTotal ? rangeTotal / weightTotal : this.estimatedRangeFromRssi(last.rssi);
    const sigma = weightTotal ? sigmaTotal / weightTotal : this.rangeSigma(last);
    const halfWidth = Math.max(2.5, sigma * 1.1);

    return {
      mode: 'annulus',
      centerLat,
      centerLng,
      innerRadius: Math.max(0.75, expectedRange - halfWidth),
      outerRadius: Math.max(2.5, expectedRange + halfWidth),
      confidence: Math.max(0.08, Math.min(0.28, 0.08 + observations.length * 0.025))
    };
  }

  candidateCloud(observations) {
    const center = this.weightedObservationCenter(observations);
    const newest = Math.max(...observations.map(o => o.timestamp));
    const spread = this.observationSpread(observations);
    const headingSweep = this.headingSweepDegrees(observations);
    const directionalObservations = this.headingObservations(observations);
    const meanDirectionalRssi = directionalObservations.length
      ? directionalObservations.reduce((sum, observation) => sum + Number(observation.rssi), 0) / directionalObservations.length
      : null;
    const maxExpectedRange = Math.max(...observations.map(o => this.estimatedRangeFromRssi(o.rssi)));
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
          const expectedRange = this.estimatedRangeFromRssi(observation.rssi);
          const actualRange = distanceMeters(
            observation.latitude,
            observation.longitude,
            candidate.lat,
            candidate.lng
          );
          const sigma = this.rangeSigma(observation);
          const residual = actualRange - expectedRange;
          const weight = this.observationWeight(observation, newest);
          logLikelihood += weight * -0.5 * Math.pow(residual / sigma, 2);
          totalWeight += weight;

          if (
            meanDirectionalRssi !== null &&
            Number.isFinite(observation.heading) &&
            observation.headingSource === 'orientation'
          ) {
            const candidateBearing = bearingDegrees(
              observation.latitude,
              observation.longitude,
              candidate.lat,
              candidate.lng
            );
            const angleDelta = angularDifferenceDegrees(candidateBearing, observation.heading);
            const alignment = Math.cos(angleDelta * Math.PI / 180);
            const signalDelta = Math.max(-1.5, Math.min(1.5, (Number(observation.rssi) - meanDirectionalRssi) / 8));
            const headingQuality = this.headingAccuracyWeight(observation.headingAccuracy);
            logLikelihood += weight * signalDelta * alignment * headingQuality * 0.7;
          }
        });

        const score = totalWeight ? logLikelihood / totalWeight : -Infinity;
        maxScore = Math.max(maxScore, score);
        candidates.push({ lat: candidate.lat, lng: candidate.lng, east, north, ix, iy, score, probability: 0 });
      }
    }

    let probabilityTotal = 0;
    candidates.forEach(candidate => {
      candidate.probability = Number.isFinite(candidate.score) ? Math.exp(candidate.score - maxScore) : 0;
      probabilityTotal += candidate.probability;
    });
    if (!probabilityTotal) return null;
    candidates.forEach(candidate => { candidate.probability /= probabilityTotal; });
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
    const headingGeometryConfidence = Math.min(1, headingSweep / 180);
    const concentrationConfidence = Math.max(0, Math.min(1, 1 - rmsSpread / solverRadius));
    const confidence = Math.max(
      0.14,
      Math.min(
        1,
        0.12 + countConfidence * 0.20 + geometryConfidence * 0.25 +
        headingGeometryConfidence * 0.20 + concentrationConfidence * 0.23
      )
    );

    return { mode: 'field', center, candidates, confidence, solverRadius, headingSweep };
  }

  solveTarget(target) {
    const observations = target.observations;
    if (!observations.length) return null;
    const spread = this.observationSpread(observations);
    const headingSweep = this.headingSweepDegrees(observations);
    const hasMovementGeometry = spread >= 5;
    const hasRotationGeometry = this.headingObservations(observations).length >= 3 && headingSweep >= MIN_HEADING_SWEEP_DEGREES;
    if (!hasMovementGeometry && !hasRotationGeometry) return this.unresolvedCloud(observations);
    return this.candidateCloud(observations) || this.unresolvedCloud(observations);
  }

  selectedMassCells(candidates, targetMass) {
    const selected = [];
    let mass = 0;
    for (const candidate of candidates) {
      selected.push(candidate);
      mass += candidate.probability;
      if (mass >= targetMass) break;
    }
    return selected;
  }

  clusterCells(cells) {
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

  clearTargetLayer(target) {
    if (target.layer) {
      map.removeLayer(target.layer);
      target.layer = null;
    }
    target.visualLayers = [];
  }

  addAnnulusLayers(layers, cloud) {
    const outer = ringPoints(cloud.centerLat, cloud.centerLng, cloud.outerRadius);
    const inner = ringPoints(cloud.centerLat, cloud.centerLng, cloud.innerRadius).reverse();
    layers.push(L.polygon([outer, inner], {
      pane: this.paneName,
      stroke: false,
      fillColor: this.color,
      fillOpacity: 0.045 + cloud.confidence * 0.075,
      fillRule: 'evenodd',
      interactive: false
    }));
  }

  addFieldMassLayers(layers, field, targetMass, opacity) {
    const selected = this.selectedMassCells(field.candidates, targetMass);
    const clusters = this.clusterCells(selected);
    clusters.forEach(cluster => {
      if (cluster.length < 3) {
        cluster.forEach(cell => {
          layers.push(L.circle([cell.lat, cell.lng], {
            pane: this.paneName,
            radius: SOLVER_STEP_METERS * 0.9,
            stroke: false,
            fillColor: this.color,
            fillOpacity: opacity,
            interactive: false
          }));
        });
        return;
      }
      const hull = convexHull(cluster);
      if (hull.length < 3) return;
      layers.push(L.polygon(hull.map(cell => [cell.lat, cell.lng]), {
        pane: this.paneName,
        stroke: false,
        fillColor: this.color,
        fillOpacity: opacity,
        smoothFactor: 1.4,
        interactive: false
      }));
    });
  }

  renderTarget(target) {
    if (!this.enabled) {
      this.clearTargetLayer(target);
      return;
    }
    const cloud = this.solveTarget(target);
    if (!cloud) return;
    target.cloud = cloud;
    target.confidence = cloud.confidence;
    this.clearTargetLayer(target);

    const layers = [];
    if (cloud.mode === 'annulus') {
      this.addAnnulusLayers(layers, cloud);
    } else {
      this.addFieldMassLayers(layers, cloud, OUTER_CLOUD_MASS, 0.055 + cloud.confidence * 0.09);
      this.addFieldMassLayers(layers, cloud, INNER_CLOUD_MASS, 0.10 + cloud.confidence * 0.18);
      if (cloud.confidence >= 0.68 && cloud.candidates.length) {
        const best = cloud.candidates[0];
        layers.push(L.circleMarker([best.lat, best.lng], {
          pane: this.paneName,
          radius: 2.5 + cloud.confidence * 2,
          stroke: false,
          fillColor: '#c8e1ff',
          fillOpacity: 0.35 + cloud.confidence * 0.5,
          interactive: false
        }));
      }
    }

    target.visualLayers = layers;
    target.layer = L.layerGroup(layers).addTo(map);
  }

  orderLayers() {
    if (!this.enabled) return;
    [...this.targets.values()]
      .filter(target => target.visualLayers?.length)
      .sort((a, b) => a.confidence - b.confidence)
      .forEach(target => {
        target.visualLayers.forEach(layer => {
          if (typeof layer.bringToFront === 'function') layer.bringToFront();
        });
      });
  }

  ingest(observations) {
    if (!Array.isArray(observations)) return;
    observations.forEach(raw => {
      const bssid = String(raw.bssid || '').toLowerCase();
      const timestamp = Number(raw.timestamp);
      if (!bssid || !Number.isFinite(timestamp)) return;

      let target = this.targets.get(bssid);
      if (!target) {
        target = {
          bssid,
          ssid: String(raw.ssid || ''),
          observations: [],
          cloud: null,
          confidence: 0,
          layer: null,
          visualLayers: [],
          lastObservationTimestamp: -Infinity
        };
        this.targets.set(bssid, target);
      }

      if (timestamp <= target.lastObservationTimestamp) return;
      target.lastObservationTimestamp = timestamp;
      target.ssid = String(raw.ssid || target.ssid || '');
      target.observations.push({
        bssid,
        ssid: target.ssid,
        rssi: Number(raw.rssi),
        frequency: Number(raw.frequency),
        timestamp,
        latitude: Number(raw.latitude),
        longitude: Number(raw.longitude),
        accuracy: Number(raw.accuracy) || 25,
        heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null,
        headingSource: String(raw.headingSource || 'none'),
        headingAccuracy: Number(raw.headingAccuracy) || 0
      });

      if (target.observations.length > MAX_OBSERVATIONS_PER_ROUTER) {
        target.observations.splice(0, target.observations.length - MAX_OBSERVATIONS_PER_ROUTER);
      }
      this.dirtyTargets.add(bssid);
    });

    const visible = [...this.targets.values()].filter(target => target.observations.length).length;
    if (visible) statusEl.textContent = `${visible} Wi-Fi targets`;
  }

  frame() {
    if (!this.enabled || !this.dirtyTargets.size) return;
    this.dirtyTargets.forEach(bssid => {
      const target = this.targets.get(bssid);
      if (target?.observations.length) this.renderTarget(target);
    });
    this.dirtyTargets.clear();
    this.orderLayers();
  }
}

const sensorRegistry = new Map();

function registerSensor(sensor) {
  sensorRegistry.set(sensor.id, sensor);
  renderSensorControls();
  return sensor;
}

function renderSensorControls() {
  if (!sensorControlsEl) return;
  sensorControlsEl.replaceChildren();
  sensorRegistry.forEach(sensor => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sensor-toggle';
    button.textContent = sensor.label;
    button.style.background = sensor.color;
    button.setAttribute('aria-pressed', String(sensor.enabled));
    button.setAttribute('aria-label', `${sensor.enabled ? 'Hide' : 'Show'} ${sensor.label}`);
    button.addEventListener('click', () => sensor.toggle());
    sensorControlsEl.appendChild(button);
  });
}

const wifiSensor = registerSensor(new WifiSensor());

function rangeLabel(meters) {
  return meters >= 1000 ? `${meters / 1000} km radius` : `${meters} m radius`;
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
  setRange(RANGE_OPTIONS[(index + 1) % RANGE_OPTIONS.length]);
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

function updateLocation(latitude, longitude, accuracy, bearing, speed) {
  const latlng = L.latLng(latitude, longitude);
  deviceLocation = {
    latitude,
    longitude,
    accuracy: Number(accuracy) || 1,
    bearing: Number.isFinite(Number(bearing)) ? Number(bearing) : null,
    speed: Number(speed) || 0
  };

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

function updateHeading(heading, accuracy, source) {
  const numericHeading = Number(heading);
  if (!Number.isFinite(numericHeading)) return;
  currentHeading = ((numericHeading % 360) + 360) % 360;
  currentHeadingAccuracy = Number(accuracy) || 0;
  currentHeadingSource = String(source || 'none');
}

function scannerFrame(timestamp) {
  requestAnimationFrame(scannerFrame);
  if (timestamp - lastRenderTime < RENDER_INTERVAL_MS) return;
  lastRenderTime = timestamp;
  sensorRegistry.forEach(sensor => sensor.frame({
    timestamp,
    location: deviceLocation,
    heading: currentHeading,
    headingAccuracy: currentHeadingAccuracy,
    headingSource: currentHeadingSource
  }));
}

window.addEventListener('resize', () => requestAnimationFrame(refitRadar));

setRange(currentRangeMeters);
requestAnimationFrame(scannerFrame);

window.Tricorder = {
  onLocation(latitude, longitude, accuracy, bearing, speed) {
    updateLocation(Number(latitude), Number(longitude), Number(accuracy), Number(bearing), Number(speed));
  },
  onHeading(heading, accuracy, source) {
    updateHeading(Number(heading), Number(accuracy), source);
  },
  onWifiScan(observations) {
    wifiSensor.ingest(observations);
  },
  onStatus(message) {
    statusEl.textContent = message;
  },
  registerSensor(sensor) {
    return registerSensor(sensor);
  },
  getSensor(id) {
    return sensorRegistry.get(id) || null;
  }
};
