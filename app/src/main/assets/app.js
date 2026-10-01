(() => {
  const status = document.getElementById('status');
  const telemetry = document.getElementById('telemetry');
  const mapHost = document.getElementById('map');

  function setStatus(message) {
    if (status) status.textContent = String(message || '');
  }

  function fail(error) {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    setStatus(`MAP FAULT: ${message}`);
  }

  if (!window.maplibregl || !window.THREE || !mapHost) {
    fail('MapLibre/Three.js failed to load');
    return;
  }

  const CHASE_PITCH = 60;
  const START_ZOOM = 18;
  const MIN_ZOOM = 1;
  const ZOOM_LIMIT = 19;
  const PHONE_SCREEN_Y = 0.70;
  const PHONE_DOT_RADIUS_METERS = 1.0;
  const PHONE_DOT_HEIGHT_METERS = 0.6;

  let map = null;
  let hasLocation = false;
  let lastLocation = null;
  let lastHeading = 0;
  let pinchStartDistance = null;
  let pinchStartZoom = null;

  function setTelemetry() {
    if (!telemetry || !lastLocation || !map) return;
    telemetry.textContent = [
      `${lastLocation.latitude.toFixed(6)}, ${lastLocation.longitude.toFixed(6)}`,
      Number.isFinite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
      Number.isFinite(lastLocation.altitude) ? `Altitude ${lastLocation.altitude.toFixed(1)} m` : '',
      `Heading ${lastHeading.toFixed(1)}°`,
      `Zoom ${map.getZoom().toFixed(2)}`,
      `Third-person pitch ${CHASE_PITCH.toFixed(0)}°`
    ].filter(Boolean).join('\n');
  }

  function chasePadding() {
    const height = Math.max(1, mapHost.clientHeight || 1);
    const top = Math.round(height * (PHONE_SCREEN_Y * 2 - 1));
    return { top: Math.max(0, top), right: 0, bottom: 0, left: 0 };
  }

  function syncChaseCamera() {
    if (!map || !lastLocation) return;
    map.jumpTo({
      center: [lastLocation.longitude, lastLocation.latitude],
      bearing: lastHeading,
      pitch: CHASE_PITCH,
      padding: chasePadding()
    });
  }

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

      const requestedZoom = Math.max(
        MIN_ZOOM,
        pinchStartZoom + Math.log2(distance / pinchStartDistance)
      );

      if (requestedZoom < ZOOM_LIMIT) {
        map.setZoom(requestedZoom);
      }

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

  function terrainElevationAtPhone() {
    if (!map || !lastLocation || typeof map.queryTerrainElevation !== 'function') return 0;
    try {
      const elevation = map.queryTerrainElevation(
        [lastLocation.longitude, lastLocation.latitude],
        { exaggerated: true }
      );
      return Number.isFinite(elevation) ? elevation : 0;
    } catch (_) {
      return 0;
    }
  }

  function phoneMercatorTransform() {
    if (!lastLocation) return null;
    const altitude = terrainElevationAtPhone() + PHONE_DOT_HEIGHT_METERS;
    const mercator = window.maplibregl.MercatorCoordinate.fromLngLat(
      [lastLocation.longitude, lastLocation.latitude],
      altitude
    );
    return {
      x: mercator.x,
      y: mercator.y,
      z: mercator.z,
      scale: mercator.meterInMercatorCoordinateUnits()
    };
  }

  const phoneLayer = {
    id: 'tricorder-phone-position',
    type: 'custom',
    renderingMode: '3d',

    onAdd(mapInstance, gl) {
      this.map = mapInstance;
      this.camera = new THREE.Camera();
      this.scene = new THREE.Scene();

      this.dot = new THREE.Mesh(
        new THREE.SphereGeometry(PHONE_DOT_RADIUS_METERS, 24, 16),
        new THREE.MeshBasicMaterial({ color: 0x39ff88 })
      );
      this.scene.add(this.dot);

      this.renderer = new THREE.WebGLRenderer({
        canvas: mapInstance.getCanvas(),
        context: gl,
        antialias: true
      });
      this.renderer.autoClear = false;
    },

    render(gl, args) {
      const transform = phoneMercatorTransform();
      if (!transform) return;

      const projectionMatrix = new THREE.Matrix4().fromArray(
        args.defaultProjectionData.mainMatrix
      );

      const modelMatrix = new THREE.Matrix4()
        .makeTranslation(transform.x, transform.y, transform.z)
        .scale(new THREE.Vector3(transform.scale, -transform.scale, transform.scale));

      this.camera.projectionMatrix = projectionMatrix.multiply(modelMatrix);
      this.renderer.resetState();
      this.renderer.render(this.scene, this.camera);
      this.map.triggerRepaint();
    }
  };

  try {
    map = new window.maplibregl.Map({
      container: mapHost,
      center: [0, 20],
      zoom: 1.5,
      pitch: CHASE_PITCH,
      bearing: 0,
      maxPitch: 85,
      interactive: false,
      attributionControl: true,
      fadeDuration: 0,
      canvasContextAttributes: { antialias: true },
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

      try {
        if (!map.getSource('tricorder-terrain')) {
          map.addSource('tricorder-terrain', {
            type: 'raster-dem',
            url: 'https://tiles.mapterhorn.com/tilejson.json',
            tileSize: 256
          });
          map.setTerrain({ source: 'tricorder-terrain', exaggeration: 1.0 });
        }
      } catch (_) {
      }

      if (!map.getLayer(phoneLayer.id)) {
        map.addLayer(phoneLayer);
      }

      syncChaseCamera();
      setStatus(hasLocation ? 'Third-person map live' : 'Third-person map — waiting for GPS');
      setTelemetry();
    });

    window.addEventListener('resize', () => {
      map.resize();
      syncChaseCamera();
    });

    map.on('error', event => {
      if (event && event.error && !hasLocation) fail(event.error);
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

      if (firstFix) map.setZoom(START_ZOOM);
      syncChaseCamera();
      map.triggerRepaint();
      setStatus('Third-person map live');
      setTelemetry();
    },

    onHeading(heading) {
      const value = Number(heading);
      if (!Number.isFinite(value)) return;
      lastHeading = ((value % 360) + 360) % 360;
      syncChaseCamera();
      map.triggerRepaint();
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
        schemaVersion: 3,
        location: lastLocation,
        heading: lastHeading,
        zoom: map ? map.getZoom() : null,
        pitch: CHASE_PITCH
      });
    },

    restoreState() {
      return true;
    }
  };

  setStatus('Loading third-person map');
})();