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
  const ZOOM_LIMIT = 16;
  const PHONE_SCREEN_Y = 0.70;
  const CHASE_PADDING_FULL_ZOOM = 12;
  const CHASE_PADDING_ZERO_ZOOM = 8;
  const PHONE_DOT_SIZE_PX = 10;
  const PHONE_HEIGHT_AGL_METERS = 1.86;
  const MAX_TRUSTED_VERTICAL_ACCURACY_METERS = 100;
  const MAX_REASONABLE_HEIGHT_ABOVE_GROUND_METERS = 180;
  const TERRAIN_SOURCE_ID = 'tricorder-terrain';
  const TERRAIN_SAMPLE_ZOOM = 14;
  const GLOBAL_PROJECTION = { type: 'vertical-perspective' };

  let map = null;
  let terrainSampler = null;
  let terrainSamplerHost = null;
  let terrainSamplerReady = false;
  let phoneMarker = null;
  let hasLocation = false;
  let lastLocation = null;
  let lastHeading = 0;
  let lastResolvedAltitude = null;
  let lastGroundElevation = null;
  let pinchStartDistance = null;
  let pinchStartZoom = null;

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function rawAltitude() {
    return lastLocation && finite(lastLocation.altitude)
      ? Number(lastLocation.altitude)
      : null;
  }

  function verticalAccuracy() {
    return lastLocation && finite(lastLocation.verticalAccuracy)
      ? Math.max(0, Number(lastLocation.verticalAccuracy))
      : null;
  }

  function groundSampleLooksResolved(value) {
    if (!finite(value)) return false;
    const ground = Number(value);
    const altitude = rawAltitude();
    const accuracy = verticalAccuracy();

    // A zero DEM result can be a transient/unresolved sample while tiles load.
    // Do not let it drag a clearly elevated GPS fix down to sea level.
    if (
      ground === 0 &&
      finite(altitude) &&
      altitude > 30 &&
      (!finite(accuracy) || accuracy <= MAX_TRUSTED_VERTICAL_ACCURACY_METERS)
    ) {
      return false;
    }

    return true;
  }

  function createTerrainSampler() {
    if (terrainSampler) return;

    terrainSamplerHost = document.createElement('div');
    terrainSamplerHost.setAttribute('aria-hidden', 'true');
    terrainSamplerHost.style.position = 'fixed';
    terrainSamplerHost.style.left = '-512px';
    terrainSamplerHost.style.top = '-512px';
    terrainSamplerHost.style.width = '256px';
    terrainSamplerHost.style.height = '256px';
    terrainSamplerHost.style.opacity = '0';
    terrainSamplerHost.style.pointerEvents = 'none';
    terrainSamplerHost.style.zIndex = '-1';
    document.body.appendChild(terrainSamplerHost);

    terrainSampler = new window.maplibregl.Map({
      container: terrainSamplerHost,
      center: [0, 0],
      zoom: TERRAIN_SAMPLE_ZOOM,
      interactive: false,
      attributionControl: false,
      renderWorldCopies: false,
      fadeDuration: 0,
      style: {
        version: 8,
        sources: {
          [TERRAIN_SOURCE_ID]: {
            type: 'raster-dem',
            url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
            tileSize: 256
          }
        },
        terrain: {
          source: TERRAIN_SOURCE_ID,
          exaggeration: 1
        },
        layers: [
          {
            id: 'terrain-sampler-background',
            type: 'background',
            paint: { 'background-color': '#000000' }
          }
        ]
      }
    });

    terrainSampler.on('load', () => {
      terrainSamplerReady = true;
      syncTerrainSampler();
    });

    terrainSampler.on('sourcedata', event => {
      if (event && event.sourceId === TERRAIN_SOURCE_ID && lastLocation) {
        resolvePhoneAltitude();
        setTelemetry();
      }
    });
  }

  function syncTerrainSampler() {
    if (!terrainSampler || !terrainSamplerReady || !lastLocation) return;
    terrainSampler.jumpTo({
      center: [lastLocation.longitude, lastLocation.latitude],
      zoom: TERRAIN_SAMPLE_ZOOM,
      pitch: 0,
      bearing: 0
    });
    terrainSampler.triggerRepaint();
  }

  function terrainElevation(latitude, longitude) {
    if (
      !terrainSampler ||
      !terrainSamplerReady ||
      typeof terrainSampler.queryTerrainElevation !== 'function'
    ) return null;

    try {
      const value = terrainSampler.queryTerrainElevation([
        Number(longitude),
        Number(latitude)
      ]);
      return groundSampleLooksResolved(value) ? Number(value) : null;
    } catch (_) {
      return null;
    }
  }

  function resolvePhoneAltitude() {
    if (!lastLocation) return null;

    const altitude = rawAltitude();
    const accuracy = verticalAccuracy();
    const groundElevation = terrainElevation(lastLocation.latitude, lastLocation.longitude);

    if (finite(groundElevation)) {
      lastGroundElevation = groundElevation;

      const tolerance = Math.max(12, finite(accuracy) ? accuracy * 2.5 : 30);
      const minimumPlausibleAltitude = groundElevation - Math.min(5, tolerance * 0.15);
      const maximumPlausibleAltitude = groundElevation + Math.max(
        MAX_REASONABLE_HEIGHT_ABOVE_GROUND_METERS,
        tolerance * 3
      );
      const rawIsTrustworthy = finite(altitude) &&
        (!finite(accuracy) || accuracy <= MAX_TRUSTED_VERTICAL_ACCURACY_METERS) &&
        altitude >= minimumPlausibleAltitude &&
        altitude <= maximumPlausibleAltitude;

      if (rawIsTrustworthy) {
        lastResolvedAltitude = altitude;
      } else if (
        !finite(lastResolvedAltitude) ||
        lastResolvedAltitude < groundElevation - 5 ||
        lastResolvedAltitude > groundElevation + MAX_REASONABLE_HEIGHT_ABOVE_GROUND_METERS
      ) {
        lastResolvedAltitude = groundElevation + PHONE_HEIGHT_AGL_METERS;
      }

      return lastResolvedAltitude;
    }

    if (
      finite(altitude) &&
      (!finite(accuracy) || accuracy <= MAX_TRUSTED_VERTICAL_ACCURACY_METERS)
    ) {
      lastResolvedAltitude = altitude;
    }

    return lastResolvedAltitude;
  }

  function setTelemetry() {
    if (!telemetry || !lastLocation || !map) return;
    const resolvedAltitude = resolvePhoneAltitude();
    telemetry.textContent = [
      `${lastLocation.latitude.toFixed(6)}, ${lastLocation.longitude.toFixed(6)}`,
      finite(lastLocation.accuracy) ? `GPS ±${Math.round(lastLocation.accuracy)} m` : '',
      finite(resolvedAltitude) ? `Altitude ${resolvedAltitude.toFixed(1)} m MSL` : '',
      finite(lastGroundElevation) ? `Ground ${lastGroundElevation.toFixed(1)} m MSL` : '',
      finite(lastLocation.verticalAccuracy) ? `Vertical ±${Math.round(lastLocation.verticalAccuracy)} m` : '',
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
      if (!finite(distance) || distance <= 0) return;
      pinchStartDistance = distance;
      pinchStartZoom = map.getZoom();
      event.preventDefault();
    }, { passive: false });

    mapHost.addEventListener('touchmove', event => {
      if (event.touches.length !== 2) return;
      if (!finite(pinchStartDistance) || !finite(pinchStartZoom)) return;

      const distance = touchDistance(event.touches);
      if (!finite(distance) || distance <= 0) return;

      const requestedZoom = Math.max(
        MIN_ZOOM,
        pinchStartZoom + Math.log2(distance / pinchStartDistance)
      );

      if (requestedZoom <= ZOOM_LIMIT) {
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

  function createPhoneMarker() {
    if (!map || phoneMarker) return;

    const dot = document.createElement('div');
    dot.setAttribute('aria-label', 'Current phone position');
    dot.style.width = `${PHONE_DOT_SIZE_PX}px`;
    dot.style.height = `${PHONE_DOT_SIZE_PX}px`;
    dot.style.boxSizing = 'border-box';
    dot.style.borderRadius = '50%';
    dot.style.background = '#39ff88';
    dot.style.border = '1px solid rgba(230,255,240,0.9)';
    dot.style.boxShadow = '0 0 5px rgba(57,255,136,0.9)';
    dot.style.pointerEvents = 'none';
    dot.style.transition = 'opacity 120ms linear';
    dot.style.willChange = 'transform, opacity';

    phoneMarker = new window.maplibregl.Marker({
      element: dot,
      anchor: 'center',
      pitchAlignment: 'viewport',
      rotationAlignment: 'viewport',
      opacity: 1,
      opacityWhenCovered: 0.35,
      subpixelPositioning: true
    });

    if (lastLocation) {
      phoneMarker
        .setLngLat([lastLocation.longitude, lastLocation.latitude])
        .addTo(map);
    }
  }

  function updatePhoneMarker() {
    if (!map || !lastLocation) return;
    createPhoneMarker();
    if (!phoneMarker) return;

    phoneMarker.setLngLat([lastLocation.longitude, lastLocation.latitude]);
    if (!phoneMarker.getElement().parentNode) phoneMarker.addTo(map);
  }

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
      maxTileCacheSize: 256,
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

    createTerrainSampler();
    bindPinchZoom();

    map.on('load', () => {
      map.resize();
      enforceGlobalProjection();
      createPhoneMarker();
      updatePhoneMarker();
      syncTerrainSampler();
      resolvePhoneAltitude();
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
      if (!finite(lat) || !finite(lon)) return;

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
      syncTerrainSampler();
      resolvePhoneAltitude();
      updatePhoneMarker();
      if (firstFix) map.setZoom(START_ZOOM);
      syncChaseCamera();
      map.triggerRepaint();
      setStatus('Third-person map live');
      setTelemetry();
    },

    onHeading(heading) {
      const value = Number(heading);
      if (!finite(value)) return;
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