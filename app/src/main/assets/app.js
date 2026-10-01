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
  let userGesturing = false;

  function updateTelemetry() {
    if (!lastLocation) return;
    setTelemetry([
      `${lastLocation.latitude.toFixed(6)}, ${lastLocation.longitude.toFixed(6)}`,
      Number.isFinite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
      Number.isFinite(lastLocation.altitude) ? `Altitude ${lastLocation.altitude.toFixed(1)} m` : '',
      `Heading ${lastHeading.toFixed(1)}°`,
      map ? `Zoom ${map.getZoom().toFixed(2)}` : ''
    ]);
  }

  function applyLiveTracking() {
    if (!map || userGesturing || !lastLocation) return;
    map.jumpTo({
      center: [lastLocation.longitude, lastLocation.latitude],
      bearing: lastHeading,
      pitch: 0
    });
  }

  function beginGesture(event) {
    if (event && event.originalEvent) userGesturing = true;
  }

  function endGesture(event) {
    if (!event || !event.originalEvent) return;
    requestAnimationFrame(() => {
      const stillGesturing =
        (typeof map.isZooming === 'function' && map.isZooming()) ||
        (typeof map.isDragging === 'function' && map.isDragging()) ||
        (typeof map.isRotating === 'function' && map.isRotating());
      if (stillGesturing) return;
      userGesturing = false;
      applyLiveTracking();
      updateTelemetry();
    });
  }

  try {
    map = new window.maplibregl.Map({
      container: 'map',
      center: [0, 20],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      interactive: true,
      attributionControl: true,
      fadeDuration: 0,
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

    if (map.touchZoomRotate) map.touchZoomRotate.enable();
    if (map.dragPan) map.dragPan.enable();

    map.on('zoomstart', beginGesture);
    map.on('dragstart', beginGesture);
    map.on('rotatestart', beginGesture);
    map.on('zoomend', endGesture);
    map.on('dragend', endGesture);
    map.on('rotateend', endGesture);

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

      if (firstFix) {
        map.jumpTo({
          center: [lon, lat],
          zoom: 18,
          bearing: lastHeading,
          pitch: 0
        });
      } else {
        applyLiveTracking();
      }

      setStatus('Map live');
      updateTelemetry();
    },

    onHeading(heading) {
      const value = Number(heading);
      if (!Number.isFinite(value)) return;
      lastHeading = ((value % 360) + 360) % 360;
      applyLiveTracking();
      updateTelemetry();
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
        heading: lastHeading,
        zoom: map ? map.getZoom() : null
      });
    },

    restoreState() {
      return true;
    }
  };

  setStatus('Loading map');
})();