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
  let hasLocation = false;
  let lastLocation = null;
  let lastHeading = 0;

  try {
    map = new maplibregl.Map({
      container: 'map',
      center: [0, 20],
      zoom: 1.5,
      pitch: 70,
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
      } catch (error) {
        fail(error);
        return;
      }

      setStatus(hasLocation ? '3D map live' : '3D map live — waiting for GPS');
      map.resize();
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

      const firstFix = !hasLocation;
      hasLocation = true;
      lastLocation = {
        latitude: lat,
        longitude: lon,
        accuracy: Number(accuracy),
        altitude: Number(altitude),
        verticalAccuracy: Number(verticalAccuracy)
      };

      map.jumpTo({
        center: [lon, lat],
        zoom: firstFix ? 18 : map.getZoom(),
        bearing: 0,
        pitch: 70
      });

      setStatus('3D map live');
      setTelemetry([
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
        Number.isFinite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
        Number.isFinite(lastLocation.altitude) ? `Altitude ${lastLocation.altitude.toFixed(1)} m` : '',
        `Pitch 70° · terrain enabled`
      ]);
    },

    onHeading(heading) {
      const value = Number(heading);
      if (Number.isFinite(value)) lastHeading = value;
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
      if (!hasLocation) setStatus(message || 'Waiting for GPS');
    },

    snapshotState() {
      return JSON.stringify({
        schemaVersion: 1,
        location: lastLocation,
        heading: lastHeading
      });
    },

    restoreState() {
      return true;
    }
  };

  setStatus('Loading 3D map');
})();