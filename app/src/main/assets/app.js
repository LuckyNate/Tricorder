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
  const CHASE_PADDING_FULL_ZOOM = 12;
  const CHASE_PADDING_ZERO_ZOOM = 8;
  const PHONE_DOT_RADIUS_METERS = 1.0;
  const PHONE_DOT_HEIGHT_METERS = 0.6;
  const EARTH_RADIUS_METERS = 6371008.8;
  const GLOBAL_PROJECTION = { type: 'vertical-perspective' };

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

  function enforceGlobalProjection() {
    if (!map || typeof map.setProjection !== 'function') return;
    const projection = typeof map.getProjection === 'function' ? map.getProjection() : null;
    if (!projection || projection.type !== GLOBAL_PROJECTION.type) {
      map.setProjection(GLOBAL_PROJECTION);
    }
  }

  function chasePadding() {
    const height = Math.max(1, mapHost.clientHeight || 1);
    const fullTop = Math.max(0, Math.round(height * (PHONE_SCREEN_Y * 2 - 1)));
    const zoom = map ? map.getZoom() : START_ZOOM;

    if (zoom >= CHASE_PADDING_FULL_ZOOM) {
      return { top: fullTop, right: 0, bottom: 0, left: 0 };
    }

    if (zoom <= CHASE_PADDING_ZERO_ZOOM) {
      return { top: 0, right: 0, bottom: 0, left: 0 };
    }

    const blend = (zoom - CHASE_PADDING_ZERO_ZOOM) /
      (CHASE_PADDING_FULL_ZOOM - CHASE_PADDING_ZERO_ZOOM);
    return {
      top: Math.round(fullTop * blend),
      right: 0,
      bottom: 0,
      left: 0
    };
  }

  function syncChaseCamera() {
    if (!map || !lastLocation) return;
    enforceGlobalProjection();
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
        enforceGlobalProjection();
        map.setZoom(requestedZoom);
        syncChaseCamera();
      }

      setTelemetry();
      event.preventDefault();
    }, { passive: false });

    const endPinch = event => {
      if (event.touches && event.touches.length >= 2) return;
      pinchStartDistance = null;
      pinchStartZoom = null;
      syncChaseCamera();
      setTelemetry();
    };

    mapHost.addEventListener('touchend', endPinch, { passive: false });
    mapHost.addEventListener('touchcancel', endPinch, { passive: false });
  }

  function phoneGlobeModelMatrix() {
    if (!lastLocation) return null;

    const longitudeRadians = lastLocation.longitude / 180 * Math.PI;
    const latitudeRadians = lastLocation.latitude / 180 * Math.PI;
    const geodeticAltitude = Number.isFinite(lastLocation.altitude) ? lastLocation.altitude : 0;
    const altitude = geodeticAltitude + PHONE_DOT_HEIGHT_METERS;
    const scale = 1 / EARTH_RADIUS_METERS;

    return new THREE.Matrix4()
      .makeRotationY(longitudeRadians)
      .multiply(new THREE.Matrix4().makeRotationX(-latitudeRadians))
      .multiply(new THREE.Matrix4().makeTranslation(
        0,
        0,
        1 + altitude / EARTH_RADIUS_METERS
      ))
      .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2))
      .multiply(new THREE.Matrix4().makeScale(scale, scale, scale));
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
      const modelMatrix = phoneGlobeModelMatrix();
      if (!modelMatrix) return;

      if (!args.defaultProjectionData || args.defaultProjectionData.projectionTransition <= 0) {
        enforceGlobalProjection();
        return;
      }

      const projectionMatrix = new THREE.Matrix4().fromArray(
        args.defaultProjectionData.mainMatrix
      );

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
      renderWorldCopies: false,
      fadeDuration: 0,
      canvasContextAttributes: { antialias: true },
      style: {
        version: 8,
        projection: GLOBAL_PROJECTION,
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
      enforceGlobalProjection();

      if (!map.getLayer(phoneLayer.id)) {
        map.addLayer(phoneLayer);
      }

      syncChaseCamera();
      setStatus(hasLocation ? 'Third-person map live' : 'Third-person map — waiting for GPS');
      setTelemetry();
    });

    map.on('projectiontransition', enforceGlobalProjection);

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

      enforceGlobalProjection();
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