(() => {
const { Sensor } = window.ScannerCore;

const METERS_PER_DEGREE_LAT = 111320;
const rttHistory = new Map();

function metersPerDegreeLng(latitude) {
  return METERS_PER_DEGREE_LAT * Math.cos(latitude * Math.PI / 180);
}

function distanceMeters(a, b) {
  const meanLat = (a.latitude + b.latitude) * 0.5;
  const north = (b.latitude - a.latitude) * METERS_PER_DEGREE_LAT;
  const east = (b.longitude - a.longitude) * metersPerDegreeLng(meanLat);
  return Math.hypot(east, north);
}

function offsetLatLng(origin, eastMeters, northMeters) {
  return {
    latitude: origin.latitude + northMeters / METERS_PER_DEGREE_LAT,
    longitude: origin.longitude + eastMeters / metersPerDegreeLng(origin.latitude)
  };
}

function solveRtt(samples) {
  const valid = samples.filter(sample => Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude) && Number.isFinite(sample.distanceMeters));
  if (!valid.length) return null;
  const newest = valid[valid.length - 1];
  if (valid.length < 2 || distanceMeters(valid[0], newest) < 1.5) {
    const sigma = Math.max(0.35, Number(newest.distanceStdDevMeters) || 1, (Number(newest.accuracy) || 0) * 0.12);
    return {
      position: { latitude: newest.latitude, longitude: newest.longitude },
      rangeRegion: {
        innerMeters: Math.max(0, newest.distanceMeters - sigma * 2),
        outerMeters: newest.distanceMeters + sigma * 2
      },
      uncertaintyMeters: newest.distanceMeters + sigma * 2,
      confidence: Math.max(0.7, Math.min(0.97, 0.94 - sigma / 20))
    };
  }

  const origin = valid[0];
  let spread = 0;
  let maxDistance = 0;
  valid.forEach(sample => {
    spread = Math.max(spread, distanceMeters(origin, sample));
    maxDistance = Math.max(maxDistance, sample.distanceMeters);
  });
  const radius = Math.min(220, Math.max(20, maxDistance + spread + 8));
  const step = Math.max(0.75, Math.min(3, radius / 45));
  let best = null;
  let bestScore = Infinity;

  for (let north = -radius; north <= radius; north += step) {
    for (let east = -radius; east <= radius; east += step) {
      if (Math.hypot(east, north) > radius) continue;
      const candidate = offsetLatLng(origin, east, north);
      let score = 0;
      valid.forEach(sample => {
        const actual = distanceMeters(sample, candidate);
        const sigma = Math.max(0.35, Number(sample.distanceStdDevMeters) || 1, (Number(sample.accuracy) || 0) * 0.08);
        const residual = actual - sample.distanceMeters;
        score += (residual * residual) / (sigma * sigma);
      });
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
  }

  if (!best) return null;
  const rmsResidual = Math.sqrt(bestScore / valid.length);
  const geometry = Math.min(1, spread / 15);
  return {
    position: best,
    rangeRegion: null,
    uncertaintyMeters: Math.max(0.75, rmsResidual * 2 + step),
    confidence: Math.max(0.72, Math.min(0.99, 0.76 + geometry * 0.16 - Math.min(0.12, rmsResidual * 0.025)))
  };
}

function applyWifiRtt(wifiSensor, rows) {
  if (!wifiSensor || !Array.isArray(rows)) return;
  rows.forEach(raw => {
    const id = String(raw.bssid || '').toLowerCase();
    if (!id) return;
    const target = wifiSensor.targets.get(id);
    if (!target) return;
    const distance = Number(raw.distanceMeters);
    if (!Number.isFinite(distance)) return;

    let history = rttHistory.get(id);
    if (!history) {
      history = [];
      rttHistory.set(id, history);
    }
    history.push({
      latitude: Number(raw.latitude),
      longitude: Number(raw.longitude),
      accuracy: Number(raw.accuracy) || 0,
      distanceMeters: distance,
      distanceStdDevMeters: Number(raw.distanceStdDevMeters) || 0,
      timestamp: Number(raw.timestamp) || Date.now()
    });
    if (history.length > 24) history.splice(0, history.length - 24);

    const solved = solveRtt(history);
    if (solved) {
      target.position = solved.position;
      target.rangeRegion = solved.rangeRegion;
      target.uncertaintyMeters = solved.uncertaintyMeters;
      target.confidence = Math.max(target.confidence || 0, solved.confidence);
    }
    target.rttDistanceMeters = distance;
    target.rttStdDevMeters = Number(raw.distanceStdDevMeters) || 0;
    const rttText = `RTT ${distance.toFixed(1)}m ±${Math.max(0.1, target.rttStdDevMeters).toFixed(1)}m`;
    const base = String(target.detail || '').replace(/ · RTT .*$/, '');
    target.detail = base ? `${base} · ${rttText}` : rttText;
  });
}

function enrichBluetooth(bluetoothSensor, rows) {
  if (!bluetoothSensor || !Array.isArray(rows)) return;
  rows.forEach(raw => {
    const id = String(raw.address || raw.id || '').toLowerCase();
    const target = bluetoothSensor.targets.get(id);
    if (!target) return;
    const extras = [];
    if (Number.isFinite(Number(raw.txPower))) extras.push(`tx ${Number(raw.txPower)} dBm`);
    if (Array.isArray(raw.serviceUuids) && raw.serviceUuids.length) extras.push(`${raw.serviceUuids.length} svc`);
    if (raw.manufacturerData && typeof raw.manufacturerData === 'object') {
      const makers = Object.keys(raw.manufacturerData);
      if (makers.length) extras.push(`mfg ${makers.join(',')}`);
    }
    if (raw.primaryPhy) extras.push(`PHY ${raw.primaryPhy}${raw.secondaryPhy && raw.secondaryPhy !== raw.primaryPhy ? `/${raw.secondaryPhy}` : ''}`);
    if (raw.connectable === false) extras.push('non-connectable');
    const base = String(target.detail || '').replace(/ · (tx |\d+ svc|mfg |PHY |non-connectable).*$/, '');
    target.detail = extras.length ? `${base}${base ? ' · ' : ''}${extras.join(' · ')}` : base;
    target.radioMetadata = raw;
  });
}

class CellularSensor extends Sensor {
  constructor() {
    super({ id: 'cellular', label: 'CELLULAR', color: '#FF5C8A' });
  }

  ingest(rows) {
    if (!Array.isArray(rows)) return;
    const seen = new Set();
    rows.forEach(raw => {
      const id = String(raw.id || '').trim();
      if (!id) return;
      seen.add(id);
      const technology = String(raw.technology || 'cell');
      const target = this.getOrCreateTarget(id, String(raw.name || `${technology} cell`));
      target.kind = technology;
      target.position = null;
      target.rangeRegion = null;
      target.uncertaintyMeters = 0;
      target.confidence = 0;
      target.lastReceivedAt = Date.now();
      target.sampleAgeMs = Number(raw.ageMs) || 0;
      const details = [`${Number(raw.dbm) || 0} dBm`, raw.registered ? 'serving' : 'neighbor'];
      if (raw.tac !== undefined) details.push(`TAC ${raw.tac}`);
      if (raw.pci !== undefined) details.push(`PCI ${raw.pci}`);
      if (raw.lac !== undefined) details.push(`LAC ${raw.lac}`);
      target.detail = details.join(' · ');
    });
    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });
  }
}

window.RadioSensors = { CellularSensor, applyWifiRtt, enrichBluetooth };
})();
