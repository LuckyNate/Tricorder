(() => {
  const status = document.getElementById('status');
  const telemetry = document.getElementById('telemetry');

  function setStatus(message) {
    if (status) status.textContent = String(message || '');
  }

  function setTelemetry(lines) {
    if (telemetry) telemetry.textContent = lines.filter(Boolean).join('\n');
  }

  function fail(error) {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    setStatus(`MAP FAULT: ${message}`);
  }

  if (!window.maplibregl) {
    fail('MapLibre failed to load');
    return;
  }

  let map;
  let mapReady = false;
  let lastValidAltitude = null;

  const pose = {
    latitude: null,
    longitude: null,
    accuracy: null,
    altitude: null,
    verticalAccuracy: null,
    heading: 0,
    pitch: 0,
    roll: 0
  };

  function cameraPitchFromPhonePitch(phonePitch) {
    // Android orientation pitch is 0° with the phone flat and approaches ±90°
    // as the rear camera approaches the horizon. MapLibre camera pitch is 0°
    // at nadir and approaches 90° at the horizon, so the magnitude is the
    // direct semantic conversion between the two coordinate conventions.
    return Math.min(85, Math.max(0, Math.abs(Number(phonePitch) || 0)));
  }

  function havePosition() {
    return Number.isFinite(pose.latitude) && Number.isFinite(pose.longitude);
  }

  function haveAltitude() {
    return Number.isFinite(lastValidAltitude);
  }

  function updateTelemetry(mapPitch) {
    setTelemetry([
      havePosition() ? `${pose.latitude.toFixed(6)}, ${pose.longitude.toFixed(6)}` : '',
      Number.isFinite(pose.accuracy) ? `GPS ±${Math.round(pose.accuracy)} m` : '',
      haveAltitude() ? `Camera altitude ${lastValidAltitude.toFixed(1)} m ASL` : 'Camera altitude waiting',
      Number.isFinite(pose.verticalAccuracy) ? `Vertical ±${Math.round(pose.verticalAccuracy)} m` : '',
      `Heading ${pose.heading.toFixed(1)}° · pitch ${mapPitch.toFixed(1)}° · roll ${pose.roll.toFixed(1)}°`
    ]);
  }

  function applyPhysicalCamera() {
    if (!mapReady || !havePosition()) return;

    if (!haveAltitude()) {
      setStatus('3D map live — waiting for valid altitude');
      updateTelemetry(cameraPitchFromPhonePitch(pose.pitch));
      return;
    }

    const mapPitch = cameraPitchFromPhonePitch(pose.pitch);

    try {
      const cameraOptions = map.calculateCameraOptionsFromCameraLngLatAltRotation(
        [pose.longitude, pose.latitude],
        lastValidAltitude,
        pose.heading,
        mapPitch,
        pose.roll
      );

      map.jumpTo(cameraOptions);
      setStatus('3D map live — physical camera scale');
      updateTelemetry(mapPitch);
    } catch (error) {
      fail(error);
    }
  }

  try {
    map = new maplibregl.Map({
      container: 'map',
      center: [0, 20],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      maxPitch: 85,
      attributionControl: true,
      antialias: true,
      style: 'https://tiles.openfreemap.org/styles/liberty'
    });

    map.on('load', () => {
      try {
        map.addSource('tricorder-terrain', {
          type: 'raster-dem',
          url: 'https://tiles.mapterhorn.com/tilejson.json'
        });
        map.setTerrain({ source: 'tricorder-terrain', exaggeration: 1.0 });

        map.addSource('tricorder-hillshade', {
          type: 'raster-dem',
          url: 'https://tiles.mapterhorn.com/tilejson.json'
        });
        map.addLayer({
          id: 'tricorder-hillshade',
          type: 'hillshade',
          source: 'tricorder-hillshade',
          paint: {
            'hillshade-exaggeration': 0.25
          }
        });

        if (typeof map.setCenterClampedToGround === 'function') {
          map.setCenterClampedToGround(false);
        }
      } catch (error) {
        fail(error);
        return;
      }

      mapReady = true;
      map.resize();
      setStatus(havePosition() ? '3D map live — waiting for valid altitude' : '3D map live — waiting for GPS');
      applyPhysicalCamera();
    });

    map.on('error', event => {
      if (event && event.error) fail(event.error);
    });
  } catch (error) {
    fail(error);
    return;
  }

  window.Tricorder = {
    onLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
      const lat = Number(latitude);
      const lon = Number(longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

      pose.latitude = lat;
      pose.longitude = lon;
      pose.accuracy = Number(accuracy);

      const nextAltitude = Number(altitude);
      if (Number.isFinite(nextAltitude)) {
        lastValidAltitude = nextAltitude;
      }
      pose.altitude = lastValidAltitude;

      const nextVerticalAccuracy = Number(verticalAccuracy);
      if (Number.isFinite(nextVerticalAccuracy)) {
        pose.verticalAccuracy = nextVerticalAccuracy;
      }

      applyPhysicalCamera();
    },

    onHeading(heading, _accuracy, _source, pitch, roll) {
      const nextHeading = Number(heading);
      const nextPitch = Number(pitch);
      const nextRoll = Number(roll);

      if (Number.isFinite(nextHeading)) pose.heading = ((nextHeading % 360) + 360) % 360;
      if (Number.isFinite(nextPitch)) pose.pitch = nextPitch;
      if (Number.isFinite(nextRoll)) pose.roll = nextRoll;

      applyPhysicalCamera();
    },

    onOrientationMatrix() {},
    onWifiScan() {},
    onBluetoothScan() {},
    onRadioFrame() {},
    onNearbyNetworkScan() {},
    onHardwareSensorCatalog() {},
    onHardwareSensorFrame() {},
    onGnssFrame() {},
    onNfcTag() {},
    onSensorAvailability() {},

    onStatus(message) {
      if (!havePosition()) setStatus(message || 'Waiting for GPS');
    },

    snapshotState() {
      return JSON.stringify({
        schemaVersion: 1,
        pose,
        lastValidAltitude
      });
    },

    restoreState() {
      return true;
    }
  };

  setStatus('Loading 3D map');
})();