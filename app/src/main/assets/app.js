(() => {
  const { RadarView, ScannerEngine } = window.ScannerCore;
  const { LocationSensor, HeadingSensor, WifiSensor, BluetoothSensor, NetworkSensor } = window.ScannerSensors;

  const ranges = [20, 50, 100, 500, 1000];
  const radar = new RadarView();
  const engine = new ScannerEngine(radar);

  const locationSensor = engine.register(new LocationSensor());
  const headingSensor = engine.register(new HeadingSensor());
  const wifiSensor = engine.register(new WifiSensor());
  const bluetoothSensor = engine.register(new BluetoothSensor());
  const networkSensor = engine.register(new NetworkSensor());

  const rangeButton = document.getElementById('range');
  const modeToggle = document.getElementById('modeToggle');
  const mode2d = document.getElementById('mode2d');
  const mode3d = document.getElementById('mode3d');
  const mapRotator = document.getElementById('mapRotator');
  const threeDView = document.getElementById('threeDView');

  let rangeIndex = 0;
  rangeButton.textContent = `${ranges[rangeIndex]} m radius`;
  radar.setRange(ranges[rangeIndex]);

  rangeButton.addEventListener('click', () => {
    rangeIndex = (rangeIndex + 1) % ranges.length;
    const range = ranges[rangeIndex];
    rangeButton.textContent = `${range} m radius`;
    radar.setRange(range);
  });

  let mode = '2d';
  modeToggle.addEventListener('click', () => {
    mode = mode === '2d' ? '3d' : '2d';
    const is3d = mode === '3d';
    mapRotator.hidden = is3d;
    threeDView.hidden = !is3d;
    mode2d.classList.toggle('active', !is3d);
    mode3d.classList.toggle('active', is3d);
    modeToggle.setAttribute('aria-pressed', String(is3d));
  });

  window.Tricorder = {
    engine,
    radar,
    onLocation(latitude, longitude, accuracy) {
      locationSensor.ingest(latitude, longitude, accuracy);
      engine.setStatus(`GPS ±${Math.round(Number(accuracy) || 0)} m`);
    },
    onHeading(heading) {
      headingSensor.ingest(heading);
    },
    onWifiScan(observations) {
      wifiSensor.ingest(observations);
    },
    onBluetoothScan(observations) {
      bluetoothSensor.ingest(observations);
    },
    onNearbyNetworkScan(observations) {
      networkSensor.ingest(observations);
    },
    onStatus(message) {
      engine.setStatus(String(message || ''));
    },
    registerSensor(sensor) {
      return engine.register(sensor);
    },
    getSensor(id) {
      return engine.get(id);
    }
  };

  engine.refreshControls();
  engine.start();
})();
