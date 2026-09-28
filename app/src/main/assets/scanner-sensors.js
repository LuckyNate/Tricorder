const { Observation, Sensor } = window.ScannerCore;

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

class LocationSensor extends Sensor {
  constructor() {
    super({ id: 'location', label: 'LOCATION', color: '#F7F7F7' });
  }

  ingest(latitude, longitude, accuracy) {
    this.engine.radar.setLocation(Number(latitude), Number(longitude), Number(accuracy));
  }
}

class HeadingSensor extends Sensor {
  constructor() {
    super({ id: 'heading', label: 'HEADING', color: '#F2A65A' });
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

  updateTarget(target) {
    const center = weightedCenter(target.observations);
    if (!center) return;
    const ranged = target.observations.filter(o => Number.isFinite(o.rssi));
    const latest = target.observations[target.observations.length - 1];
    const ranges = ranged.map(o => this.rangeFromRssi(o.rssi));
    const averageRange = ranges.length ? ranges.reduce((a, b) => a + b, 0) / ranges.length : this.maxRange;
    const countConfidence = Math.min(1, target.observations.length / 14);
    const rangedConfidence = ranged.length ? 0.3 : 0;
    target.position = center;
    target.uncertaintyMeters = Math.max(2.5, averageRange * (ranged.length > 2 ? 0.58 : 0.95), latest?.accuracy || 10);
    target.confidence = Math.max(0.08, Math.min(0.88, 0.12 + countConfidence * 0.46 + rangedConfidence));
  }
}

class WifiSensor extends RangedRadioSensor {
  constructor() {
    super({
      id: 'wifi',
      label: 'WI-FI',
      color: '#39D353',
      rssiAtOneMeter: -45,
      pathLossExponent: 2.6,
      maxRange: 150
    });
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
    super({
      id: 'bluetooth',
      label: 'BLUETOOTH',
      color: '#0082FC',
      rssiAtOneMeter: -59,
      pathLossExponent: 2.2,
      maxRange: 80
    });
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
      target.detail = Number.isFinite(Number(raw.rssi)) ? `${Number(raw.rssi)} dBm` : 'paired / unresolved';
      const observation = new Observation(this.id, id, raw);
      if (observation.timestamp <= target.lastSeen && target.observations.length) return;
      target.addObservation(observation);
      this.updateTarget(target);
      if (!Number.isFinite(observation.rssi)) {
        target.uncertaintyMeters = Math.max(target.uncertaintyMeters, 80);
        target.confidence = Math.min(target.confidence, 0.12);
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
      const lat = Number(raw.latitude);
      const lon = Number(raw.longitude);
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        target.position = { latitude: lat, longitude: lon };
      } else if (this.engine.radar.location) {
        target.position = {
          latitude: this.engine.radar.location.latitude,
          longitude: this.engine.radar.location.longitude
        };
      }
      target.uncertaintyMeters = 80;
      target.confidence = 0.08;
    });
    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });
  }
}

window.ScannerSensors = { LocationSensor, HeadingSensor, WifiSensor, BluetoothSensor, NetworkSensor };
