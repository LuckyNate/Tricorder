(() => {
const { Observation, Sensor } = window.ScannerCore;

const METERS_PER_DEGREE_LAT = 111320;
const SOLVER_STEP_METERS = 8;
const MIN_HEADING_SWEEP_DEGREES = 30;
const MAX_SOLVER_RADIUS_METERS = 180;
const SOLUTION_EPSILON_METERS = 0.05;
const SOLUTION_EPSILON_CONFIDENCE = 0.005;

function metersPerDegreeLng(latitude) {
  return METERS_PER_DEGREE_LAT * Math.cos(latitude * Math.PI / 180);
}

function offsetLatLng(latitude, longitude, eastMeters, northMeters) {
  return {
    latitude: latitude + northMeters / METERS_PER_DEGREE_LAT,
    longitude: longitude + eastMeters / metersPerDegreeLng(latitude)
  };
}

function distanceMeters(a, b) {
  const meanLat = (a.latitude + b.latitude) * 0.5;
  const north = (b.latitude - a.latitude) * METERS_PER_DEGREE_LAT;
  const east = (b.longitude - a.longitude) * metersPerDegreeLng(meanLat);
  return Math.hypot(east, north);
}

function bearingDegrees(a, b) {
  const meanLat = (a.latitude + b.latitude) * 0.5;
  const north = (b.latitude - a.latitude) * METERS_PER_DEGREE_LAT;
  const east = (b.longitude - a.longitude) * metersPerDegreeLng(meanLat);
  return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

function angularDifferenceDegrees(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function acceptSpatialSolution(target, solution = {}) {
  if (!target || !solution.position) return false;
  const latitude = Number(solution.position.latitude);
  const longitude = Number(solution.position.longitude);
  const uncertainty = Number(solution.uncertaintyMeters);
  const confidence = Number(solution.confidence);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(uncertainty) || !Number.isFinite(confidence)) return false;

  const hasCurrent = Boolean(target.position) && Number.isFinite(Number(target.uncertaintyMeters)) && Number.isFinite(Number(target.confidence));
  if (hasCurrent) {
    const currentUncertainty = Number(target.uncertaintyMeters);
    const currentConfidence = Number(target.confidence);
    const uncertaintyNoWorse = uncertainty <= currentUncertainty + SOLUTION_EPSILON_METERS;
    const confidenceNoWorse = confidence + SOLUTION_EPSILON_CONFIDENCE >= currentConfidence;
    const strictlyBetter =
      uncertainty < currentUncertainty - SOLUTION_EPSILON_METERS ||
      confidence > currentConfidence + SOLUTION_EPSILON_CONFIDENCE;
    if (!uncertaintyNoWorse || !confidenceNoWorse || !strictlyBetter) return false;
  }

  target.position = { ...solution.position, latitude, longitude };
  target.rangeRegion = solution.rangeRegion === undefined ? null : solution.rangeRegion;
  target.uncertaintyMeters = uncertainty;
  target.confidence = confidence;
  if (Number.isFinite(Number(solution.directionSpreadMeters))) target.directionSpreadMeters = Number(solution.directionSpreadMeters);
  if (Number.isFinite(Number(solution.headingSweepDegrees))) target.headingSweepDegrees = Number(solution.headingSweepDegrees);
  target.solutionUpdatedAt = Date.now();
  return true;
}

function weightedCenter(observations) {
  const valid = observations.filter(o => o.latitude !== null && o.longitude !== null);
  if (!valid.length) return null;
  let lat = 0;
  let lon = 0;
  let total = 0;
  valid.forEach(o => {
    const accuracyWeight = 1 / Math.max(4, o.accuracy || 25);
    const signalWeight = Number.isFinite(o.rssi) ? Math.max(0.2, Math.min(1.2, (o.rssi + 100) / 45)) : 0.35;
    const w = accuracyWeight * signalWeight;
    lat += o.latitude * w;
    lon += o.longitude * w;
    total += w;
  });
  if (!total) return { latitude: valid[valid.length - 1].latitude, longitude: valid[valid.length - 1].longitude };
  return { latitude: lat / total, longitude: lon / total };
}

function observationSpread(observations) {
  const valid = observations.filter(o => o.latitude !== null && o.longitude !== null);
  let spread = 0;
  for (let i = 0; i < valid.length; i += 1) {
    for (let j = i + 1; j < valid.length; j += 1) {
      spread = Math.max(spread, distanceMeters(valid[i], valid[j]));
    }
  }
  return spread;
}

function headingSweep(observations) {
  const headings = observations
    .filter(o => Number.isFinite(o.heading) && o.headingSource === 'orientation')
    .map(o => ((o.heading % 360) + 360) % 360)
    .sort((a, b) => a - b);
  if (headings.length < 2) return 0;
  let largestGap = 0;
  for (let i = 0; i < headings.length; i += 1) {
    const next = i === headings.length - 1 ? headings[0] + 360 : headings[i + 1];
    largestGap = Math.max(largestGap, next - headings[i]);
  }
  return 360 - largestGap;
}

function headingAccuracyWeight(accuracy) {
  const value = Number(accuracy) || 0;
  if (value >= 3) return 1;
  if (value === 2) return 0.75;
  if (value === 1) return 0.45;
  return 0.2;
}

class LocationSensor extends Sensor {
  constructor() {
    super({ id: 'location', label: 'LOCATION', color: '#F7F7F7', showList: false });
  }
  ingest(latitude, longitude, accuracy) {
    this.engine.radar.setLocation(Number(latitude), Number(longitude), Number(accuracy));
  }
}

class HeadingSensor extends Sensor {
  constructor() {
    super({ id: 'heading', label: 'HEADING', color: '#F2A65A', showList: false });
  }
  ingest(heading) {
    this.engine.radar.setHeading(Number(heading));
  }
}

class RangedRadioSensor extends Sensor {
  constructor(config) {
    super(config);
    this.rssiAtOneMeter = config.rssiAtOneMeter;
    this.pathLossExponent = config.pathLossExponent;
    this.maxRange = config.maxRange;
  }

  rangeFromRssi(rssi) {
    if (!Number.isFinite(Number(rssi))) return this.maxRange;
    const meters = Math.pow(10, (this.rssiAtOneMeter - Number(rssi)) / (10 * this.pathLossExponent));
    return Math.max(0.75, Math.min(this.maxRange, meters));
  }

  rangeSigma(observation) {
    const expected = this.rangeFromRssi(observation.rssi);
    const gps = Math.min(16, Math.max(0, Number(observation.accuracy) || 0) * 0.35);
    return Math.max(3, expected * 0.30, gps);
  }

  observationWeight(observation, newestTimestamp) {
    const ageSeconds = Math.max(0, (newestTimestamp - observation.timestamp) / 1000);
    const recency = Math.exp(-ageSeconds / 300);
    const gps = 1 / Math.max(4, Number(observation.accuracy) || 25);
    const signal = Number.isFinite(observation.rssi)
      ? Math.max(0.2, Math.min(1, (observation.rssi + 100) / 55))
      : 0.2;
    return recency * gps * signal;
  }

  solveDirectionalTarget(target) {
    const observations = target.observations.filter(o =>
      o.latitude !== null && o.longitude !== null && Number.isFinite(o.rssi)
    );
    if (!observations.length) return null;

    const center = weightedCenter(observations);
    if (!center) return null;

    const spread = observationSpread(observations);
    const sweep = headingSweep(observations);
    const newest = Math.max(...observations.map(o => o.timestamp));
    const expectedRanges = observations.map(o => this.rangeFromRssi(o.rssi));
    const maxExpectedRange = Math.max(...expectedRanges);
    const solverRadius = Math.min(
      MAX_SOLVER_RADIUS_METERS,
      Math.max(35, Math.min(this.maxRange + spread, maxExpectedRange + spread * 0.75 + 24))
    );

    const directional = observations.filter(o =>
      Number.isFinite(o.heading) && o.headingSource === 'orientation'
    );
    const meanDirectionalRssi = directional.length
      ? directional.reduce((sum, o) => sum + o.rssi, 0) / directional.length
      : null;

    let best = null;
    let bestScore = -Infinity;
    const candidates = [];

    for (let north = -solverRadius; north <= solverRadius; north += SOLVER_STEP_METERS) {
      for (let east = -solverRadius; east <= solverRadius; east += SOLVER_STEP_METERS) {
        if (Math.hypot(east, north) > solverRadius) continue;
        const candidate = offsetLatLng(center.latitude, center.longitude, east, north);
        let score = 0;
        let totalWeight = 0;

        observations.forEach(observation => {
          const expectedRange = this.rangeFromRssi(observation.rssi);
          const actualRange = distanceMeters(observation, candidate);
          const sigma = this.rangeSigma(observation);
          const residual = actualRange - expectedRange;
          const weight = this.observationWeight(observation, newest);
          score += weight * -0.5 * Math.pow(residual / sigma, 2);
          totalWeight += weight;

          if (
            meanDirectionalRssi !== null &&
            Number.isFinite(observation.heading) &&
            observation.headingSource === 'orientation' &&
            sweep >= MIN_HEADING_SWEEP_DEGREES
          ) {
            const candidateBearing = bearingDegrees(observation, candidate);
            const delta = angularDifferenceDegrees(candidateBearing, observation.heading);
            const alignment = Math.cos(delta * Math.PI / 180);
            const signalDelta = Math.max(-1.5, Math.min(1.5, (observation.rssi - meanDirectionalRssi) / 7));
            score += weight * signalDelta * alignment * headingAccuracyWeight(observation.headingAccuracy) * 0.8;
          }
        });

        if (totalWeight) score /= totalWeight;
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
        candidates.push({ position: candidate, score });
      }
    }

    if (!best || !candidates.length) return null;

    let probabilityTotal = 0;
    candidates.forEach(candidate => {
      candidate.probability = Math.exp(candidate.score - bestScore);
      probabilityTotal += candidate.probability;
    });
    if (!probabilityTotal) return null;

    let meanEast = 0;
    let meanNorth = 0;
    candidates.forEach(candidate => {
      candidate.probability /= probabilityTotal;
      const meanLat = (center.latitude + candidate.position.latitude) * 0.5;
      candidate.east = (candidate.position.longitude - center.longitude) * metersPerDegreeLng(meanLat);
      candidate.north = (candidate.position.latitude - center.latitude) * METERS_PER_DEGREE_LAT;
      meanEast += candidate.east * candidate.probability;
      meanNorth += candidate.north * candidate.probability;
    });

    let variance = 0;
    candidates.forEach(candidate => {
      const dx = candidate.east - meanEast;
      const dy = candidate.north - meanNorth;
      variance += candidate.probability * (dx * dx + dy * dy);
    });

    const rmsSpread = Math.sqrt(variance);
    const movementConfidence = Math.min(1, spread / 40);
    const headingConfidence = Math.min(1, sweep / 180);
    const countConfidence = Math.min(1, observations.length / 12);
    const concentrationConfidence = Math.max(0, Math.min(1, 1 - rmsSpread / solverRadius));
    const confidence = Math.max(
      0.10,
      Math.min(
        0.96,
        0.10 + countConfidence * 0.22 + movementConfidence * 0.28 +
        headingConfidence * 0.18 + concentrationConfidence * 0.22
      )
    );

    return {
      position: best,
      uncertaintyMeters: Math.max(3, Math.min(solverRadius, rmsSpread)),
      confidence,
      spread,
      headingSweep: sweep
    };
  }

  updateTarget(target) {
    const ranged = target.observations.filter(o => Number.isFinite(o.rssi));
    const positioned = ranged.filter(o => o.latitude !== null && o.longitude !== null);
    const latest = target.observations[target.observations.length - 1];
    if (!ranged.length) return;

    const spread = observationSpread(positioned);
    const sweep = headingSweep(positioned);
    const hasGeometry = positioned.length >= 2 && (spread >= 2 || sweep >= MIN_HEADING_SWEEP_DEGREES);

    if (hasGeometry) {
      const solved = this.solveDirectionalTarget(target);
      if (solved) {
        acceptSpatialSolution(target, {
          position: solved.position,
          rangeRegion: null,
          uncertaintyMeters: solved.uncertaintyMeters,
          confidence: solved.confidence,
          directionSpreadMeters: solved.spread,
          headingSweepDegrees: solved.headingSweep
        });
        return;
      }
    }

    const center = weightedCenter(positioned);
    if (!center) {
      if (!target.position) target.confidence = Math.max(Number(target.confidence) || 0, 0.08);
      return;
    }
    const ranges = positioned.map(o => this.rangeFromRssi(o.rssi));
    const averageRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const countConfidence = Math.min(1, positioned.length / 14);
    const width = Math.max(3, averageRange * 0.5, latest ? latest.accuracy : 10);
    const rangeRegion = { center, innerMeters: Math.max(0, averageRange - width), outerMeters: averageRange + width };
    acceptSpatialSolution(target, {
      position: center,
      rangeRegion,
      uncertaintyMeters: rangeRegion.outerMeters,
      confidence: Math.max(0.08, Math.min(0.42, 0.10 + countConfidence * 0.32))
    });
  }
}

class WifiSensor extends RangedRadioSensor {
  constructor() {
    super({ id: 'wifi', label: 'WI-FI', color: '#39D353', rssiAtOneMeter: -45, pathLossExponent: 2.6, maxRange: 150 });
  }

  ingest(rows) {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    rows.forEach(raw => {
      const id = String(raw.bssid || '').toLowerCase();
      if (!id) return;
      seen.add(id);
      const name = String(raw.ssid || '').trim() || id;
      const target = this.getOrCreateTarget(id, name);
      target.kind = 'router';
      target.detail = `${Number(raw.rssi) || 0} dBm`;
      target.lastReceivedAt = Date.now();
      target.sampleAgeMs = Number(raw.ageMs) || 0;
      const observation = new Observation(this.id, id, raw);
      if (observation.timestamp <= target.lastSeen) return;
      target.addObservation(observation);
      this.updateTarget(target);
    });
    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });
  }
}

class BluetoothSensor extends RangedRadioSensor {
  constructor() {
    super({ id: 'bluetooth', label: 'BLUETOOTH', color: '#0082FC', rssiAtOneMeter: -59, pathLossExponent: 2.2, maxRange: 80 });
  }

  ingest(rows) {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    rows.forEach(raw => {
      const id = String(raw.address || raw.id || '').toLowerCase();
      if (!id) return;
      seen.add(id);
      const target = this.getOrCreateTarget(id, String(raw.name || 'Bluetooth device'));
      target.kind = String(raw.source || 'bluetooth');
      target.knowledgeOnly = raw.source === 'bonded' && (raw.rssi === null || raw.rssi === undefined);
      target.detail = raw.rssi !== null && raw.rssi !== undefined && Number.isFinite(Number(raw.rssi))
        ? `${Number(raw.rssi)} dBm${raw.bonded ? ' · paired' : ''}` : 'paired / unresolved';
      target.lastReceivedAt = Date.now();
      target.sampleAgeMs = Number(raw.ageMs) || 0;
      const observation = new Observation(this.id, id, raw);
      if (observation.timestamp <= target.lastSeen && target.observations.length) return;
      target.addObservation(observation);
      if (Number.isFinite(observation.rssi)) {
        this.updateTarget(target);
      } else if (!target.position) {
        target.rangeRegion = null;
        target.uncertaintyMeters = 80;
        target.confidence = Math.max(Number(target.confidence) || 0, 0.08);
      }
    });
    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });
  }
}

class NetworkSensor extends Sensor {
  constructor() {
    super({ id: 'network', label: 'NETWORK / CAST', color: '#FFD166' });
  }

  ingest(rows) {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    rows.forEach(raw => {
      const id = String(raw.id || '').trim();
      if (!id) return;
      seen.add(id);
      const target = this.getOrCreateTarget(id, String(raw.name || raw.kind || 'Network device'));
      target.kind = String(raw.kind || raw.source || 'network');
      target.detail = String(raw.detail || raw.source || '');
      target.lastSeen = Number(raw.timestamp) || Date.now();
      target.lastReceivedAt = Date.now();
      target.sampleAgeMs = Number(raw.ageMs) || 0;
      target.position = null;
      target.presenceKnown = Boolean(raw.persistent);
      target.uncertaintyMeters = 80;
      target.confidence = 0;
    });
    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });
  }
}

window.ScannerSensors = { LocationSensor, HeadingSensor, WifiSensor, BluetoothSensor, NetworkSensor, acceptSpatialSolution };
})();
