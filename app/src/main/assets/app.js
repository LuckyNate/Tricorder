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
    return Math.min(85, Math.max(0, Math.abs(Number(phonePitch) || 0)));
  }

  function havePosition() {
    return Number.isFinite(pose.latitude) && Number.isFinite(pose.longitude);
  }

  function haveAltitude() {
    return Number.isFinite(lastValidAltitude);
  }

  function terrainElevationAtPhone() {
    if (!mapReady || !havePosition() || typeof map.queryTerrainElevation !== 'function') return null;
    const elevation = map.queryTerrainElevation([pose.longitude, pose.latitude]);
    return Number.isFinite(elevation) ? elevation : null;
  }

  function updateTelemetry(mapPitch, terrainElevation, physicalCamera) {
    const cameraAltitude = Number.isFinite(terrainElevation) ? terrainElevation + 5 : null;
    setTelemetry([
      havePosition() ? `${pose.latitude.toFixed(6)}, ${pose.longitude.toFixed(6)}` : '',
      Number.isFinite(pose.accuracy) ? `GPS ±${Math.round(pose.accuracy)} m` : '',
      haveAltitude() ? `WGS84 altitude ${lastValidAltitude.toFixed(1)} m` : 'WGS84 altitude unavailable',
      Number.isFinite(pose.verticalAccuracy) ? `Vertical ±${Math.round(pose.verticalAccuracy)} m` : '',
      Number.isFinite(terrainElevation) ? `Terrain ${terrainElevation.toFixed(1)} m MSL` : '',
      Number.isFinite(cameraAltitude) ? `Camera ${cameraAltitude.toFixed(1)} m MSL · +5.0 m AGL` : '',
      `Heading ${pose.heading.toFixed(1)}° · pitch ${mapPitch.toFixed(1)}° · roll ${pose.roll.toFixed(1)}°`,
      physicalCamera ? 'Physical camera active' : '3D overview — terrain elevation unavailable'
    ]);
  }

  function showOverview(mapPitch, terrainElevation, reason) {
    map.jumpTo({
      center: [pose.longitude, pose.latitude],
      zoom: 18,
      bearing: pose.heading,
      pitch: 70,
      roll: 0
    });
    setStatus(`3D map live — ${reason}`);
    updateTelemetry(mapPitch, terrainElevation, false);
  }

  function applyPhysicalCamera() {
    if (!mapReady || !havePosition()) return;

    const mapPitch = cameraPitchFromPhonePitch(pose.pitch);
    const terrainElevation = terrainElevationAtPhone();

    if (!Number.isFinite(terrainElevation)) {
      showOverview(mapPitch, terrainElevation, 'waiting for terrain elevation');
      return;
    }

    const cameraAltitude = terrainElevation + 5;

    try {
      const cameraOptions = map.calculateCameraOptionsFromCameraLngLatAltRotation(
        [pose.longitude, pose.latitude],
        cameraAltitude,
        pose.heading,
        mapPitch,
        pose.roll
      );

      map.jumpTo(cameraOptions);
      setStatus('3D map live — camera 5.0 m above terrain');
      updateTelemetry(mapPitch, terrainElevation, true);
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
      setStatus(havePosition() ? '3D map live — waiting for terrain elevation' : '3D map live — waiting for GPS');
      applyPhysicalCamera();
    });

    map.on('terrain', applyPhysicalCamera);

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