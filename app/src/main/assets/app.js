(() => {
  function fault(message) {
    if (window.__tricorderShowFault) window.__tricorderShowFault(message);
    const status = document.getElementById('status');
    if (status) status.textContent = `FAULT: ${String(message || 'unknown')}`;
  }

  try {
    if (!window.ScannerCore) throw new Error('ScannerCore failed to load');
    if (!window.ScannerSensors) throw new Error('ScannerSensors failed to load');
    if (!window.RadioSensors) throw new Error('RadioSensors failed to load');

    const { RadarView, ScannerEngine } = window.ScannerCore;
    const { LocationSensor, HeadingSensor, WifiSensor, BluetoothSensor, NetworkSensor } = window.ScannerSensors;
    const { CellularSensor, applyWifiRtt, enrichBluetooth } = window.RadioSensors;

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
    function syncRangeButton() {
      rangeButton.textContent = `Range: ${ranges[rangeIndex]} Meters`;
    }
    syncRangeButton();

    const radar = new RadarView();
    radar.setRange(ranges[rangeIndex]);

    rangeButton.addEventListener('click', () => {
      rangeIndex = (rangeIndex + 1) % ranges.length;
      const range = ranges[rangeIndex];
      syncRangeButton();
      radar.setRange(range);
    });

    let mode = '2d';
    function applyMode(nextMode) {
      mode = nextMode === '3d' ? '3d' : '2d';
      const is3d = mode === '3d';
      mapRotator.hidden = is3d;
      threeDView.hidden = !is3d;
      mode2d.classList.toggle('active', !is3d);
      mode3d.classList.toggle('active', is3d);
      modeToggle.setAttribute('aria-pressed', String(is3d));
    }

    modeToggle.addEventListener('click', () => {
      applyMode(mode === '2d' ? '3d' : '2d');
    });

    const engine = new ScannerEngine(radar);
    const sourceStatus = document.getElementById('sourceStatus');
    const sourceState = {
      location: 'location waiting',
      wifi: 'Wi-Fi waiting',
      bluetooth: 'Bluetooth waiting',
      cellular: 'cellular waiting',
      network: 'network waiting',
      radios: 'radio capabilities waiting'
    };
    const availability = {};
    let receivedWifiSnapshot = false;
    function showSources() {
      if (receivedWifiSnapshot && !availability.wifi) {
        const wifiTargets = [...wifiSensor.targets.values()];
        const fresh = wifiTargets.some(target => Date.now() - target.lastReceivedAt + target.sampleAgeMs < 5000);
        sourceState.wifi = `Wi-Fi ${wifiTargets.length} (${fresh ? 'fresh' : 'cached / waiting for new scan'})`;
      }
      if (sourceStatus) sourceStatus.textContent = Object.keys(sourceState)
        .map(id => availability[id] ? `${id}: ${availability[id]}` : sourceState[id]).join(' · ');
    }

    const locationSensor = engine.register(new LocationSensor());
    const headingSensor = engine.register(new HeadingSensor());
    const wifiSensor = engine.register(new WifiSensor());
    const bluetoothSensor = engine.register(new BluetoothSensor());
    const cellularSensor = engine.register(new CellularSensor());
    const networkSensor = engine.register(new NetworkSensor());

    function radioCapabilityText(capabilities) {
      if (!capabilities || typeof capabilities !== 'object') return 'radio capabilities unknown';
      const parts = [];
      parts.push(capabilities.wifiRttSupported
        ? `RTT ${capabilities.wifiRttAvailable ? 'ready' : 'unavailable'}`
        : 'RTT unsupported');
      parts.push(capabilities.wifiAwareSupported
        ? `Aware ${capabilities.wifiAwareAvailable ? 'ready' : 'unavailable'}`
        : 'Aware unsupported');
      parts.push(capabilities.uwbSupported ? 'UWB peer-ready' : 'UWB unsupported');
      return parts.join(' / ');
    }

    window.Tricorder = {
      engine,
      radar,
      snapshotState() {
        return JSON.stringify({
          schemaVersion: 1,
          savedAt: Date.now(),
          engine: engine.exportRecoveryState(),
          ui: { mode, rangeIndex }
        });
      },
      restoreState(snapshot) {
        try {
          const state = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
          if (!state || state.schemaVersion !== 1 || !state.engine) return false;
          if (!engine.importRecoveryState(state.engine)) return false;

          const restoredRange = Number(engine.radar.rangeMeters);
          const restoredIndex = ranges.indexOf(restoredRange);
          if (restoredIndex >= 0) rangeIndex = restoredIndex;
          else if (state.ui && Number.isInteger(Number(state.ui.rangeIndex))) {
            rangeIndex = Math.max(0, Math.min(ranges.length - 1, Number(state.ui.rangeIndex)));
            radar.setRange(ranges[rangeIndex]);
          }
          syncRangeButton();
          applyMode(state.ui && state.ui.mode === '3d' ? '3d' : '2d');
          engine.needsRender = true;
          showSources();
          return true;
        } catch (error) {
          fault(error.message || error);
          return false;
        }
      },
      onLocation(latitude, longitude, accuracy) {
        try {
          locationSensor.ingest(latitude, longitude, accuracy);
          sourceState.location = `observer ±${Math.round(Number(accuracy) || 0)}m`;
          showSources();
        } catch (error) { fault(error.message || error); }
      },
      onHeading(heading) {
        try { headingSensor.ingest(heading); } catch (error) { fault(error.message || error); }
      },
      onWifiScan(observations) {
        try {
          wifiSensor.ingest(observations);
          receivedWifiSnapshot = true;
          if (observations.some(o => Number(o.ageMs) < 5000)) delete availability.wifi;
          engine.needsRender = true;
          showSources();
        } catch (error) { fault(error.message || error); }
      },
      onBluetoothScan(observations) {
        try {
          bluetoothSensor.ingest(observations);
          enrichBluetooth(bluetoothSensor, observations);
          sourceState.bluetooth = `Bluetooth ${bluetoothSensor.targets.size}`;
          engine.needsRender = true;
          showSources();
        } catch (error) { fault(error.message || error); }
      },
      onRadioFrame(frame) {
        try {
          const payload = frame || {};
          const rtt = Array.isArray(payload.rtt) ? payload.rtt : [];
          const cellular = Array.isArray(payload.cellular) ? payload.cellular : [];
          applyWifiRtt(wifiSensor, rtt);
          cellularSensor.ingest(cellular);
          sourceState.cellular = `cellular ${cellularSensor.targets.size}`;
          sourceState.radios = radioCapabilityText(payload.capabilities);
          engine.needsRender = true;
          showSources();
        } catch (error) { fault(error.message || error); }
      },
      onNearbyNetworkScan(observations) {
        try {
          networkSensor.ingest(observations);
          sourceState.network = `network ${networkSensor.targets.size}`;
          showSources();
        } catch (error) { fault(error.message || error); }
      },
      onStatus(message) {
        engine.setStatus(String(message || ''));
      },
      onSensorAvailability(id, state) {
        if (Object.prototype.hasOwnProperty.call(sourceState, id)) {
          if (state) availability[id] = String(state);
          else delete availability[id];
          showSources();
        }
      },
      registerSensor(sensor) { return engine.register(sensor); },
      getSensor(id) { return engine.get(id); }
    };

    engine.refreshControls();
    engine.setStatus('Scanner ready — waiting for sensors');
    window.setInterval(showSources, 1000);
    engine.start();
  } catch (error) {
    fault(error && error.message ? error.message : error);
  }
})();
