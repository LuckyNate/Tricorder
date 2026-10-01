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
      pitch: 0,
      bearing: 0,
      attributionControl: true,
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '© OpenStreetMap contributors'
          }
        },
        layers: [
          {
            id: 'osm',
            type: 'raster',
            source: 'osm',
            minzoom: 0,
            maxzoom: 19
          }
        ]
      }
    });

    map.on('load', () => {
      setStatus(hasLocation ? 'Map live' : 'Map live — waiting for GPS');
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
        pitch: 0
      });

      setStatus('Map live');
      setTelemetry([
        `${lat.toFixed(6)}, ${lon.toFixed(6)}`,
        Number.isFinite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
        Number.isFinite(lastLocation.altitude) ? `Altitude ${lastLocation.altitude.toFixed(1)} m` : ''
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

  setStatus('Loading map');
})();