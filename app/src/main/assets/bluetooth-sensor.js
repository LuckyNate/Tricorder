const BLUETOOTH_RSSI_AT_ONE_METER = -59;
const BLUETOOTH_PATH_LOSS_EXPONENT = 2.2;
const BLUETOOTH_UNKNOWN_RADIUS_METERS = 80;

if (!map.getPane('bluetoothClouds')) {
  map.createPane('bluetoothClouds');
  map.getPane('bluetoothClouds').style.zIndex = 440;
}

WifiSensor.prototype.renderTarget = function renderTarget(target) {
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
        fillColor: this.color,
        fillOpacity: 0.35 + cloud.confidence * 0.5,
        interactive: false
      }));
    }
  }

  target.visualLayers = layers;
  target.layer = L.layerGroup(layers).addTo(map);
};

class BluetoothSensor extends WifiSensor {
  constructor() {
    super();
    this.id = 'bluetooth';
    this.label = 'BLUETOOTH DEVICE';
    this.color = '#0082FC';
    this.paneName = 'bluetoothClouds';
    this.usesHeading = true;
    this.targets = new Map();
    this.dirtyTargets = new Set();
  }

  estimatedRangeFromRssi(rssi) {
    const meters = Math.pow(
      10,
      (BLUETOOTH_RSSI_AT_ONE_METER - Number(rssi)) / (10 * BLUETOOTH_PATH_LOSS_EXPONENT)
    );
    return Math.max(0.5, Math.min(80, meters));
  }

  solveTarget(target) {
    const ranged = target.observations.filter(observation => Number.isFinite(observation.rssi));
    if (ranged.length) {
      return super.solveTarget({ ...target, observations: ranged });
    }

    const last = target.observations[target.observations.length - 1];
    if (!last) return null;
    return {
      mode: 'annulus',
      centerLat: last.latitude,
      centerLng: last.longitude,
      innerRadius: 0.75,
      outerRadius: BLUETOOTH_UNKNOWN_RADIUS_METERS,
      confidence: 0.05
    };
  }

  addAnnulusLayers(layers, cloud) {
    const outer = ringPoints(cloud.centerLat, cloud.centerLng, cloud.outerRadius);
    const inner = ringPoints(cloud.centerLat, cloud.centerLng, cloud.innerRadius).reverse();
    layers.push(L.polygon([outer, inner], {
      pane: this.paneName,
      stroke: false,
      fillColor: this.color,
      fillOpacity: 0.12 + cloud.confidence * 0.14,
      fillRule: 'evenodd',
      interactive: false
    }));
  }

  ingest(observations) {
    if (!Array.isArray(observations)) return;

    const currentAddresses = new Set();

    observations.forEach(raw => {
      const address = String(raw.address || '').toLowerCase();
      const timestamp = Number(raw.timestamp);
      if (!address || !Number.isFinite(timestamp)) return;
      currentAddresses.add(address);

      const source = String(raw.source || 'bluetooth');
      const numericRssi = Number(raw.rssi);
      const hasRssi = raw.rssi !== undefined && raw.rssi !== null && Number.isFinite(numericRssi);

      let target = this.targets.get(address);
      if (!target) {
        target = {
          bssid: address,
          ssid: String(raw.name || 'Bluetooth'),
          observations: [],
          cloud: null,
          confidence: 0,
          layer: null,
          visualLayers: [],
          lastObservationTimestamp: -Infinity
        };
        this.targets.set(address, target);
      }

      if (timestamp <= target.lastObservationTimestamp) {
        if (source === 'bonded' && target.observations.length) {
          const last = target.observations[target.observations.length - 1];
          last.latitude = Number(raw.latitude);
          last.longitude = Number(raw.longitude);
          last.accuracy = Number(raw.accuracy) || 25;
          this.dirtyTargets.add(address);
        }
        return;
      }

      target.lastObservationTimestamp = timestamp;
      target.ssid = String(raw.name || target.ssid || 'Bluetooth');
      target.observations.push({
        bssid: address,
        ssid: target.ssid,
        rssi: hasRssi ? numericRssi : NaN,
        frequency: 0,
        timestamp,
        latitude: Number(raw.latitude),
        longitude: Number(raw.longitude),
        accuracy: Number(raw.accuracy) || 25,
        heading: Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null,
        headingSource: String(raw.headingSource || 'none'),
        headingAccuracy: Number(raw.headingAccuracy) || 0,
        source,
        confirmedNearby: Boolean(raw.confirmedNearby)
      });

      if (target.observations.length > MAX_OBSERVATIONS_PER_ROUTER) {
        target.observations.splice(0, target.observations.length - MAX_OBSERVATIONS_PER_ROUTER);
      }
      this.dirtyTargets.add(address);
    });

    [...this.targets.entries()].forEach(([address, target]) => {
      if (currentAddresses.has(address)) return;
      this.clearTargetLayer(target);
      this.targets.delete(address);
      this.dirtyTargets.delete(address);
    });

    const visible = [...this.targets.values()].filter(target => target.observations.length).length;
    if (visible) statusEl.textContent = `${visible} Bluetooth targets`;
  }
}

wifiSensor.color = '#39D353';
const bluetoothSensor = window.Tricorder.registerSensor(new BluetoothSensor());
renderSensorControls();
window.Tricorder.onBluetoothScan = observations => bluetoothSensor.ingest(observations);
