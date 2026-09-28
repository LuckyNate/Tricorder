const RADAR_MARGIN_PX = 12;
const RANGE_OPTIONS = [20, 50, 100, 500, 1000];
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
    const candidate = spread >= 2.5 ? this.candidateCloud(observations) : null;
    return candidate || this.unresolvedCloud(observations);
  }

  clearTargetLayer(target) {
    if (target.layer) {
      map.removeLayer(target.layer);
      target.layer = null;
    }
    if (target.marker) {
      map.removeLayer(target.marker);
      target.marker = null;
    }
  }

  renderAnnulus(target, solved) {
    this.clearTargetLayer(target);
    const outer = ringPoints(solved.centerLat, solved.centerLng, solved.outerRadius);
    const inner = ringPoints(solved.centerLat, solved.centerLng, solved.innerRadius).reverse();
    target.layer = L.polygon([outer, inner], {
      pane: this.paneName,
      stroke: false,
      fillColor: this.color,
      fillOpacity: solved.confidence * 0.65,
      interactive: false
    }).addTo(map);
  }

  renderField(target, solved) {
    this.clearTargetLayer(target);
    const maxProbability = solved.candidates[0]?.probability || 0;
    if (!maxProbability) return;

    const thresholdOuter = maxProbability * OUTER_CLOUD_MASS;
    const selected = solved.candidates.filter(candidate => candidate.probability >= thresholdOuter);
    const hull = convexHull(selected);
    if (hull.length >= 3) {
      const latLngs = hull.map(point => [point.lat, point.lng]);
      target.layer = L.polygon(latLngs, {
        pane: this.paneName,
        stroke: false,
        fillColor: this.color,
        fillOpacity: 0.12 + solved.confidence * 0.52,
        interactive: false
      }).addTo(map);
    }

    if (solved.confidence >= 0.68) {
      const best = solved.candidates[0];
      target.marker = L.circleMarker([best.lat, best.lng], {
        pane: this.paneName,
        radius: 3.5,
        stroke: false,
        fillColor: this.color,
        fillOpacity: Math.min(1, 0.45 + solved.confidence * 0.55),
        interactive: false
      }).addTo(map);
    }
  }

  renderTarget(target) {
    if (!this.enabled) return;
    const solved = this.solveTarget(target);
    if (!solved) {
      this.clearTargetLayer(target);
      return;
    }
    if (solved.mode === 'annulus') this.renderAnnulus(target, solved);
    else this.renderField(target, solved);
  }

  ingest(scan) {
    if (!scan || !scan.bssid || !Number.isFinite(scan.latitude) || !Number.isFinite(scan.longitude)) return;
    const timestamp = Number(scan.timestamp) || Date.now();
    const target = this.targets.get(scan.bssid) || {
      bssid: scan.bssid,
      ssid: scan.ssid || '',
      observations: [],
      layer: null,
      marker: null,
      lastObservationTimestamp: 0
    };

    if (timestamp <= target.lastObservationTimestamp) return;

    target.ssid = scan.ssid || target.ssid;
    target.lastObservationTimestamp = timestamp;
    target.observations.push({
      latitude: Number(scan.latitude),
      longitude: Number(scan.longitude),
      accuracy: Number(scan.accuracy),
      rssi: Number(scan.rssi),
      frequency: Number(scan.frequency),
      timestamp,
      heading: Number.isFinite(Number(scan.heading)) ? Number(scan.heading) : null,
      headingAccuracy: Number(scan.headingAccuracy) || 0,
      headingSource: scan.headingSource || 'none'
    });
    if (target.observations.length > MAX_OBSERVATIONS_PER_ROUTER) target.observations.shift();
    this.targets.set(scan.bssid, target);
    this.dirtyTargets.add(scan.bssid);
  }

  frame() {
    if (!this.enabled || !this.dirtyTargets.size) return;
    const dirty = Array.from(this.dirtyTargets);
    this.dirtyTargets.clear();
    dirty.forEach(bssid => {
      const target = this.targets.get(bssid);
      if (target) this.renderTarget(target);
    });
  }
}

const sensorRegistry = new Map();

function renderSensorControls() {
  if (!sensorControlsEl) return;
  sensorControlsEl.replaceChildren();
  sensorRegistry.forEach(sensor => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sensor-toggle${sensor.enabled ? ' active' : ''}`;
    button.style.setProperty('--sensor-color', sensor.color);
    button.textContent = sensor.label;
    button.setAttribute('aria-pressed', String(sensor.enabled));
    button.addEventListener('click', () => sensor.toggle());
    sensorControlsEl.appendChild(button);
  });
}

function registerSensor(sensor) {
  if (!(sensor instanceof ScannerSensor)) return null;
  sensorRegistry.set(sensor.id, sensor);
  renderSensorControls();
  return sensor;
}

const wifiSensor = registerSensor(new WifiSensor());

function rangeZoomForMeters(meters) {
  if (!deviceLocation) return 18;
  const mapEl = document.getElementById('map');
  const width = Math.max(240, mapEl?.clientWidth || window.innerWidth || 360);
  const usableRadiusPx = Math.max(60, width / 2 - RADAR_MARGIN_PX);
  const metersPerPixel = meters / usableRadiusPx;
  const latitudeRadians = deviceLocation.latitude * Math.PI / 180;
  return Math.log2((156543.03392 * Math.cos(latitudeRadians)) / metersPerPixel);
}

function applyRange() {
  if (!deviceLocation) return;
  map.setView([deviceLocation.latitude, deviceLocation.longitude], rangeZoomForMeters(currentRangeMeters), { animate: false });
  if (rangeRing) rangeRing.setRadius(currentRangeMeters);
  if (rangeEl) rangeEl.textContent = `${currentRangeMeters} m`;
}

function cycleRange() {
  const index = RANGE_OPTIONS.indexOf(currentRangeMeters);
  currentRangeMeters = RANGE_OPTIONS[(index + 1) % RANGE_OPTIONS.length];
  applyRange();
}

function setMode(mode) {
  currentMode = mode === '3d' ? '3d' : '2d';
  document.body.dataset.mode = currentMode;
  if (mode2d) mode2d.classList.toggle('active', currentMode === '2d');
  if (mode3d) mode3d.classList.toggle('active', currentMode === '3d');
}

function applyHeading() {
  const mapEl = document.getElementById('map');
  if (!mapEl) return;
  const heading = Number.isFinite(currentHeading) ? currentHeading : 0;
  mapEl.style.transform = `rotate(${-heading}deg) scale(1.42)`;
}

function updateLocation(location) {
  if (!location || !Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return;
  deviceLocation = {
    latitude: Number(location.latitude),
    longitude: Number(location.longitude),
    accuracy: Number(location.accuracy) || 0,
    timestamp: Number(location.timestamp) || Date.now()
  };

  const latLng = [deviceLocation.latitude, deviceLocation.longitude];
  if (!deviceMarker) deviceMarker = L.marker(latLng, { icon: deviceIcon, interactive: false }).addTo(map);
  else deviceMarker.setLatLng(latLng);

  if (!accuracyRing) {
    accuracyRing = L.circle(latLng, {
      radius: Math.max(1, deviceLocation.accuracy),
      stroke: false,
      fillColor: '#ffffff',
      fillOpacity: 0.08,
      interactive: false
    }).addTo(map);
  } else {
    accuracyRing.setLatLng(latLng);
    accuracyRing.setRadius(Math.max(1, deviceLocation.accuracy));
  }

  if (!rangeRing) {
    rangeRing = L.circle(latLng, {
      radius: currentRangeMeters,
      color: '#ffffff',
      weight: 1,
      opacity: 0.45,
      fill: false,
      interactive: false
    }).addTo(map);
  } else {
    rangeRing.setLatLng(latLng);
  }

  if (!hasInitialFix) {
    hasInitialFix = true;
    applyRange();
  } else {
    map.panTo(latLng, { animate: false });
  }
}

function updateHeading(heading) {
  if (!heading) return;
  const value = Number(heading.heading);
  if (!Number.isFinite(value)) return;
  currentHeading = value;
  currentHeadingAccuracy = Number(heading.accuracy) || 0;
  currentHeadingSource = heading.source || 'none';
  applyHeading();
}

function frame(timestamp) {
  if (timestamp - lastRenderTime >= RENDER_INTERVAL_MS) {
    lastRenderTime = timestamp;
    sensorRegistry.forEach(sensor => sensor.frame(timestamp));
  }
  requestAnimationFrame(frame);
}

if (rangeEl) rangeEl.addEventListener('click', cycleRange);
if (modeToggle) modeToggle.addEventListener('click', () => setMode(currentMode === '2d' ? '3d' : '2d'));
setMode('2d');
renderSensorControls();
requestAnimationFrame(frame);

window.Tricorder = {
  onLocation: updateLocation,
  onHeading: updateHeading,
  onWifiScan(scan) {
    if (Array.isArray(scan)) scan.forEach(item => wifiSensor.ingest(item));
    else wifiSensor.ingest(scan);
  },
  onStatus(message) {
    if (statusEl) statusEl.textContent = String(message || '');
  },
  registerSensor,
  getSensor(id) {
    return sensorRegistry.get(id) || null;
  }
};
