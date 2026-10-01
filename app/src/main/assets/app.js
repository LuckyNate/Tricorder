(() => {
  const status = document.getElementById('status');
  const telemetry = document.getElementById('telemetry');
  const mapHost = document.getElementById('map');

  function setStatus(message) {
    if (status) status.textContent = String(message || '');
  }

  function setTelemetry() {
    if (!telemetry || !lastLocation || !map) return;
    telemetry.textContent = [
      `${lastLocation.latitude.toFixed(6)}, ${lastLocation.longitude.toFixed(6)}`,
      Number.isFinite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
      Number.isFinite(lastLocation.altitude) ? `Altitude ${lastLocation.altitude.toFixed(1)} m` : '',
      `Heading ${lastHeading.toFixed(1)}°`,
      `Zoom ${map.getZoom().toFixed(2)}`
    ].filter(Boolean).join('\n');
  }

  function fail(error) {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    setStatus(`MAP FAULT: ${message}`);
  }

  if (!window.maplibregl || !mapHost) {
    fail('MapLibre failed to load');
    return;
  }

  let map = null;
  let hasLocation = false;
  let lastLocation = null;
  let lastHeading = 0;

  let pinchStartDistance = null;
  let pinchStartZoom = null;

  function touchDistance(touches) {
    if (!touches || touches.length < 2) return null;
    const dx = touches[1].clientX - touches[0].clientX;
    const dy = touches[1].clientY - touches[0].clientY;
    return Math.hypot(dx, dy);
  }

  function bindPinchZoom() {
    mapHost.addEventListener('touchstart', event => {
      if (event.touches.length !== 2) return;
      const distance = touchDistance(event.touches);
      if (!Number.isFinite(distance) || distance <= 0) return;
      pinchStartDistance = distance;
      pinchStartZoom = map.getZoom();
      event.preventDefault();
    }, { passive: false });

    mapHost.addEventListener('touchmove', event => {
      if (event.touches.length !== 2) return;
      if (!Number.isFinite(pinchStartDistance) || !Number.isFinite(pinchStartZoom)) return;

      const distance = touchDistance(event.touches);
      if (!Number.isFinite(distance) || distance <= 0) return;

      const zoomDelta = Math.log2(distance / pinchStartDistance);
      const zoom = Math.max(1, Math.min(19, pinchStartZoom + zoomDelta));
      map.setZoom(zoom);
      setTelemetry();
      event.preventDefault();
    }, { passive: false });

    const endPinch = event => {
      if (event.touches && event.touches.length >= 2) return;
      pinchStartDistance = null;
      pinchStartZoom = null;
      setTelemetry();
    };

    mapHost.addEventListener('touchend', endPinch, { passive: false });
    mapHost.addEventListener('touchcancel', endPinch, { passive: false });
  }

  try {
    map = new window.maplibregl.Map({
      container: mapHost,
      center: [0, 20],
      zoom: 1.5,
      pitch: 0,
      bearing: 0,
      interactive: false,
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

    bindPinchZoom();

    map.on('load', () => {
      map.resize();
      setStatus(hasLocation ? 'Map live' : 'Map live — waiting for GPS');
      setTelemetry();
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

      if (firstFix) map.setZoom(18);
      map.setCenter([lon, lat]);
      map.setBearing(lastHeading);

      setStatus('Map live');
      setTelemetry();
    },

    onHeading(heading) {
      const value = Number(heading);
      if (!Number.isFinite(value)) return;
      lastHeading = ((value % 360) + 360) % 360;
      map.setBearing(lastHeading);
      setTelemetry();
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