(() => {
  function fault(message) {
    if (window.__tricorderShowFault) window.__tricorderShowFault(message);
    const status = document.getElementById('status');
    if (status) status.textContent = `FAULT: ${String(message || 'unknown')}`;
  }

  try {
    if (!window.ScannerCore) throw new Error('ScannerCore failed to load');
    if (!window.ScannerSensors) throw new Error('ScannerSensors failed to load');

    const { RadarView, ScannerEngine } = window.ScannerCore;
    const { LocationSensor, HeadingSensor, WifiSensor, BluetoothSensor, NetworkSensor } = window.ScannerSensors;

    const ranges = [20, 50, 100, 500, 1000];
    const controlStatus = document.getElementById('controlStatus');
    let rangeButton = document.getElementById('range');
    if (!rangeButton && controlStatus) {
      rangeButton = document.createElement('button');
      rangeButton.id = 'range';
      rangeButton.type = 'button';
      rangeButton.setAttribute('aria-label', 'Change radar range');
      controlStatus.appendChild(rangeButton);
    }
    if (!rangeButton) throw new Error('Range selector missing');

    const modeToggle = document.getElementById('modeToggle');
    const mode2d = document.getElementById('mode2d');
    const mode3d = document.getElementById('mode3d');
    const mapRotator = document.getElementById('mapRotator');
    const threeDView = document.getElementById('threeDView');

    let rangeIndex = 0;
    rangeButton.textContent = `${ranges[rangeIndex]} m radius`;

    const radar = new RadarView();
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

    const engine = new ScannerEngine(radar);

    const locationSensor = engine.register(new LocationSensor());
    const headingSensor = engine.register(new HeadingSensor());
    const wifiSensor = engine.register(new WifiSensor());
    const bluetoothSensor = engine.register(new BluetoothSensor());
    const networkSensor = engine.register(new NetworkSensor());

    window.Tricorder = {
      engine,
      radar,
      onLocation(latitude, longitude, accuracy) {
        try {
          locationSensor.ingest(latitude, longitude, accuracy);
          engine.setStatus(`GPS ±${Math.round(Number(accuracy) || 0)} m`);
        } catch (error) { fault(error.message || error); }
      },
      onHeading(heading) {
        try { headingSensor.ingest(heading); } catch (error) { fault(error.message || error); }
      },
      onWifiScan(observations) {
        try { wifiSensor.ingest(observations); } catch (error) { fault(error.message || error); }
      },
      onBluetoothScan(observations) {
        try { bluetoothSensor.ingest(observations); } catch (error) { fault(error.message || error); }
      },
      onNearbyNetworkScan(observations) {
        try { networkSensor.ingest(observations); } catch (error) { fault(error.message || error); }
      },
      onStatus(message) {
        engine.setStatus(String(message || ''));
      },
      registerSensor(sensor) { return engine.register(sensor); },
      getSensor(id) { return engine.get(id); }
    };

    engine.refreshControls();
    engine.setStatus('Scanner ready — waiting for sensors');
    engine.start();
  } catch (error) {
    fault(error && error.message ? error.message : error);
  }
})();
