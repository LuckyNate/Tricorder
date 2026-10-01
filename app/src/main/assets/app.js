(() => {
  const status = document.getElementById('status');
  const telemetry = document.getElementById('telemetry');
  const mapHost = document.getElementById('map');
  const spatialHost = document.getElementById('spatialScene');
  const video = document.getElementById('camera');

  function setStatus(message) {
    if (status) status.textContent = String(message || '');
  }

  function setTelemetry(lines) {
    if (telemetry) telemetry.textContent = lines.filter(Boolean).join('\n');
  }

  function fail(error) {
    const message = error && error.message ? error.message : String(error || 'unknown error');
    setStatus(`SPATIAL FAULT: ${message}`);
  }

  if (!window.maplibregl || !window.WorldSpace || !window.SpatialEngine || !window.THREE) {
    fail('spatial dependencies failed to load');
    return;
  }

  const world = new window.WorldSpace.WorldSpaceModel(2);
  let map = null;
  let mapReady = false;
  let spatial = null;

  function syncReferenceMap() {
    const pose = world.pose;
    if (!mapReady || !pose.hasLocation()) return;
    map.resize();
    map.jumpTo({
      center: [pose.longitude, pose.latitude],
      zoom: 18,
      bearing: 0,
      pitch: 0,
      roll: 0
    });
    map.triggerRepaint();
  }

  function updateTelemetry() {
    const pose = world.pose;
    const mode = spatial ? spatial.mode : 'waiting';
    setTelemetry([
      pose.hasLocation() ? `${pose.latitude.toFixed(6)}, ${pose.longitude.toFixed(6)}` : '',
      Number.isFinite(pose.accuracy) ? `GPS ±${Math.round(pose.accuracy)} m` : '',
      Number.isFinite(pose.rawAltitude) ? `Raw GPS altitude ${pose.rawAltitude.toFixed(1)} m` : '',
      Number.isFinite(pose.groundElevationMSL) ? `Terrain ${pose.groundElevationMSL.toFixed(1)} m MSL` : 'Terrain waiting',
      Number.isFinite(pose.cameraElevationMSL) ? `Camera ${pose.cameraElevationMSL.toFixed(1)} m MSL · +${pose.cameraHeightAGL.toFixed(1)} m AGL` : '',
      `Heading ${pose.heading.toFixed(1)}° · pitch ${pose.pitch.toFixed(1)}° · roll ${pose.roll.toFixed(1)}°`,
      `Spatial mode ${mode}`
    ]);
    if (!pose.hasLocation()) setStatus('Waiting for GPS');
    else if (!Number.isFinite(pose.groundElevationMSL)) setStatus('3D world live — waiting for terrain');
    else setStatus('3D world live — third-person camera');
  }

  async function startCamera() {
    if (!video || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 }
        }
      });
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
    } catch (_) {
    }
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
      preserveDrawingBuffer: true,
      style: 'https://tiles.openfreemap.org/styles/liberty'
    });

    mapReady = true;
    spatial = new window.SpatialEngine({ world, map, container: spatialHost, video });
    spatial.start();
    startCamera();
    syncReferenceMap();
    updateTelemetry();

    map.on('load', () => {
      try {
        if (!map.getSource('tricorder-terrain')) {
          map.addSource('tricorder-terrain', {
            type: 'raster-dem',
            url: 'https://tiles.mapterhorn.com/tilejson.json',
            tileSize: 256
          });
          map.setTerrain({ source: 'tricorder-terrain', exaggeration: 1.0 });
        }
      } catch (error) {
        fail(error);
        return;
      }

      syncReferenceMap();
      updateTelemetry();
    });

    map.on('render', () => {
      if (spatial && typeof spatial.onMapRender === 'function') spatial.onMapRender();
    });

    map.on('sourcedata', event => {
      if (event.sourceId === 'tricorder-terrain') updateTelemetry();
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
      world.setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy);
      syncReferenceMap();
      updateTelemetry();
    },

    onHeading(heading, _accuracy, _source, pitch, roll) {
      world.setHeading(heading, pitch, roll);
      updateTelemetry();
    },

    onOrientationMatrix(matrix, displayRotation, declinationDegrees) {
      world.setOrientation(matrix, displayRotation, declinationDegrees);
      updateTelemetry();
    },

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
      if (!world.pose.hasLocation()) setStatus(message || 'Waiting for GPS');
    },

    snapshotState() {
      const pose = world.pose;
      return JSON.stringify({
        schemaVersion: 2,
        latitude: pose.latitude,
        longitude: pose.longitude,
        accuracy: pose.accuracy,
        rawAltitude: pose.rawAltitude,
        verticalAccuracy: pose.verticalAccuracy,
        groundElevationMSL: pose.groundElevationMSL,
        cameraHeightAGL: pose.cameraHeightAGL
      });
    },

    restoreState() {
      return true;
    }
  };

  setStatus('Loading unified 3D world');
})();