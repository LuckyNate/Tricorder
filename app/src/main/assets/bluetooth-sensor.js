const BLUETOOTH_RSSI_AT_ONE_METER = -59;
const BLUETOOTH_PATH_LOSS_EXPONENT = 2.2;

if (!map.getPane('bluetoothClouds')) {
  map.createPane('bluetoothClouds');
  map.getPane('bluetoothClouds').style.zIndex = 440;
}

class BluetoothSensor extends WifiSensor {
  constructor() {
    super();
    this.id = 'bluetooth';
    this.label = 'BLUETOOTH DEVICE';
    this.color = '#c58cff';
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

  ingest(observations) {
    if (!Array.isArray(observations)) return;

    const adapted = observations.map(raw => ({
      ...raw,
      bssid: String(raw.address || '').toLowerCase(),
      ssid: String(raw.name || 'Bluetooth'),
      frequency: 0
    }));

    super.ingest(adapted);

    const visible = [...this.targets.values()].filter(target => target.observations.length).length;
    if (visible) statusEl.textContent = `${visible} Bluetooth targets`;
  }
}

const bluetoothSensor = window.Tricorder.registerSensor(new BluetoothSensor());
window.Tricorder.onBluetoothScan = observations => bluetoothSensor.ingest(observations);
