(() => {
  function fault(message) {
    if (window.__tricorderShowFault) window.__tricorderShowFault(message);
    const status = document.getElementById('status');
    if (status) status.textContent = `FAULT: ${String(message || 'unknown')}`;
  }

  try {
    if (!window.ScannerCore) throw new Error('ScannerCore failed to load');
    if (!window.ScannerSensors) throw new Error('ScannerSensors failed to load');
    if (!window.SpatialView) throw new Error('SpatialView failed to load');

    const { RadarView, ScannerEngine } = window.ScannerCore;
    const { LocationSensor, HeadingSensor } = window.ScannerSensors;

    const appVersion = 'TRICORDER_VERSION_TOKEN';
    const ranges = [10, 20, 50, 100, 500, 1000];
    const rangeButton = document.getElementById('range');
    const modeToggle = document.getElementById('modeToggle');
    const mode2d = document.getElementById('mode2d');
    const mode3d = document.getElementById('mode3d');
    const viewPane = document.getElementById('viewPane');
    const mapRotator = document.getElementById('mapRotator');
    const threeDView = document.getElementById('threeDView');
    const sourceStatus = document.getElementById('sourceStatus');

    if (!rangeButton || !modeToggle || !mode2d || !mode3d || !viewPane || !mapRotator || !threeDView) {
      throw new Error('Mapping UI missing');
    }

    const radar = new RadarView();
    const spatial = new window.SpatialView(radar);
    const engine = new ScannerEngine(radar);

    // Mapping sensors only during the 3D map rebuild.
    const locationSensor = engine.register(new LocationSensor());
    const headingSensor = engine.register(new HeadingSensor());

    const pose = {
      heading: 0,
      pitch: 0,
      roll: 0,
      altitude: null,
      verticalAccuracy: null,
      latitude: null,
      longitude: null,
      accuracy: null
    };

    let rangeIndex = 1;
    let mode = '2d';

    function syncRangeButton() {
      rangeButton.textContent = `${ranges[rangeIndex]} m radius`;
    }

    function showMappingStatus() {
      if (!sourceStatus) return;
      const location = Number.isFinite(pose.latitude) && Number.isFinite(pose.longitude);
      const altitude = Number.isFinite(pose.altitude);
      sourceStatus.textContent = `v${appVersion} · mapping · location ${location ? 'live' : 'waiting'} · altitude ${altitude ? `${pose.altitude.toFixed(1)} m` : 'waiting'} · orientation live`;
    }

    function applyMode(nextMode) {
      mode = nextMode === '3d' ? '3d' : '2d';
      const is3d = mode === '3d';
      mapRotator.hidden = false;
      viewPane.classList.toggle('mode-3d', is3d);
      threeDView.hidden = !is3d;
      mode2d.classList.toggle('active', !is3d);
      mode3d.classList.toggle('active', is3d);
      modeToggle.setAttribute('aria-pressed', String(is3d));
      spatial.setActive(is3d);
    }

    function setRange(index) {
      rangeIndex = Math.max(0, Math.min(ranges.length - 1, Number(index) || 0));
      const range = ranges[rangeIndex];
      radar.setRange(range);
      spatial.setRange(range);
      syncRangeButton();
    }

    rangeButton.addEventListener('click', () => {
      setRange((rangeIndex + 1) % ranges.length);
    });

    modeToggle.addEventListener('click', () => {
      applyMode(mode === '2d' ? '3d' : '2d');
    });

    function renderSpatialFrame(now) {
      spatial.render(engine, now);
      window.requestAnimationFrame(renderSpatialFrame);
    }

    window.Tricorder = {
      engine,
      radar,
      spatial,

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
          if (!state || state.schemaVersion !== 1) return false;
          if (state.engine) engine.importRecoveryState(state.engine);
          const savedRangeIndex = state.ui && Number.isInteger(Number(state.ui.rangeIndex))
            ? Number(state.ui.rangeIndex)
            : rangeIndex;
          setRange(savedRangeIndex);
          applyMode(state.ui && state.ui.mode === '3d' ? '3d' : '2d');
          return true;
        } catch (error) {
          fault(error.message || error);
          return false;
        }
      },

      onLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
        try {
          locationSensor.ingest(latitude, longitude, accuracy);
          pose.latitude = Number(latitude);
          pose.longitude = Number(longitude);
          pose.accuracy = Number(accuracy);
          if (Number.isFinite(Number(altitude))) pose.altitude = Number(altitude);
          if (Number.isFinite(Number(verticalAccuracy))) pose.verticalAccuracy = Number(verticalAccuracy);
          radar.world.setLocation(
            pose.latitude,
            pose.longitude,
            pose.accuracy,
            pose.altitude,
            pose.verticalAccuracy
          );
          spatial.setPose(pose);
          if (typeof radar.syncReferenceOverlay === 'function') radar.syncReferenceOverlay();
          showMappingStatus();
        } catch (error) {
          fault(error.message || error);
        }
      },

      onHeading(heading, _accuracy, _source, pitch, roll) {
        try {
          headingSensor.ingest(heading);
          pose.heading = Number(heading) || 0;
          if (Number.isFinite(Number(pitch))) pose.pitch = Number(pitch);
          if (Number.isFinite(Number(roll))) pose.roll = Number(roll);
          spatial.setPose(pose);
        } catch (error) {
          fault(error.message || error);
        }
      },

      // Non-mapping sensor actions are intentionally disabled for this rebuild.
      onWifiScan() {},
      onBluetoothScan() {},
      onRadioFrame() {},
      onNearbyNetworkScan() {},
      onHardwareSensorCatalog() {},
      onHardwareSensorFrame() {},
      onGnssFrame() {},
      onNfcTag() {},

      onStatus(message) {
        engine.setStatus(String(message || ''));
      },

      onSensorAvailability() {
        // Disabled while only the mapping sensors are active.
      },

      registerSensor(sensor) {
        return engine.register(sensor);
      },

      getSensor(id) {
        return engine.get(id);
      }
    };

    setRange(rangeIndex);
    applyMode('2d');
    showMappingStatus();
    engine.refreshControls();
    engine.setStatus('Mapping rebuild — detections disabled');
    engine.start();
    window.requestAnimationFrame(renderSpatialFrame);
  } catch (error) {
    fault(error && error.message ? error.message : error);
  }
})();