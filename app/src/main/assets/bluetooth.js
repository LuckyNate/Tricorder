map.createPane('bluetoothClouds');
map.getPane('bluetoothClouds').style.zIndex = 435;

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
  }

  ingest(observations) {
    if (!Array.isArray(observations)) return;

    const now = performance.now();
    const mapped = observations.map(raw => ({
      ...raw,
      bssid: String(raw.address || '').toLowerCase(),
      ssid: String(raw.name || 'Bluetooth')
    }));

    super.ingest(mapped);

    mapped.forEach(raw => {
      const address = String(raw.bssid || '').toLowerCase();
      const target = this.targets.get(address);
      if (target) target.lastSeenFrameTime = now;
    });

    const visible = [...this.targets.values()].filter(target => target.observations.length).length;
    if (visible) statusEl.textContent = `${visible} Bluetooth targets`;
  }

  frame(state) {
    const now = Number(state?.timestamp) || performance.now();
    this.targets.forEach((target, address) => {
      if (
        Number.isFinite(target.lastSeenFrameTime) &&
        now - target.lastSeenFrameTime > 30000
      ) {
        this.clearTargetLayer(target);
        this.targets.delete(address);
        this.dirtyTargets.delete(address);
      }
    });
    super.frame(state);
  }
}

wifiSensor.color = '#39D353';
const bluetoothSensor = registerSensor(new BluetoothSensor());
renderSensorControls();

window.Tricorder.onBluetoothScan = function onBluetoothScan(observations) {
  bluetoothSensor.ingest(observations);
};
