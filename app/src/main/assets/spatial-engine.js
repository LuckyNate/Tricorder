(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;
  const DEG = Math.PI / 180;
  const FRAME_INTERVAL_MS = 1000 / 30;
  const DEFAULT_HORIZONTAL_FOV_DEGREES = 70;
  const GROUND_GRID = 12;

  class SharedRadarView extends BaseRadarView {
    constructor(world = new WorldSpaceModel()) {
      super();
      this.world = world;
      this.world.setRange(this.rangeMeters);
    }

    setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
      super.setLocation(latitude, longitude, accuracy);
      this.world.setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy);
    }

    setHeading(degrees) {
      if (!finite(degrees)) return;
      this.heading = wrapDegrees(Number(degrees));
      this.world.setHeading(this.heading);
      if (this.rotatorEl) {
        this.rotatorEl.style.transform = `rotate(${-this.heading}deg) scale(1.18)`;
      }
    }

    setRange(meters) {
      this.world.setRange(meters);
      super.setRange(meters);
    }

    render() {
      if (this.targetLayer) this.targetLayer.replaceChildren();
      if (this.pingLayer) this.pingLayer.replaceChildren();
    }

    ping() {
      return false;
    }
  }

  function affineFromTriangles(source, destination) {
    const [s0, s1, s2] = source;
    const [d0, d1, d2] = destination;
    const denominator = s0.x * (s1.y - s2.y) + s1.x * (s2.y - s0.y) + s2.x * (s0.y - s1.y);
    if (Math.abs(denominator) < 1e-6) return null;

    const a = (d0.x * (s1.y - s2.y) + d1.x * (s2.y - s0.y) + d2.x * (s0.y - s1.y)) / denominator;
    const c = (d0.x * (s2.x - s1.x) + d1.x * (s0.x - s2.x) + d2.x * (s1.x - s0.x)) / denominator;
    const e = (d0.x * (s1.x * s2.y - s2.x * s1.y) + d1.x * (s2.x * s0.y - s0.x * s2.y) + d2.x * (s0.x * s1.y - s1.x * s0.y)) / denominator;

    const b = (d0.y * (s1.y - s2.y) + d1.y * (s2.y - s0.y) + d2.y * (s0.y - s1.y)) / denominator;
    const d = (d0.y * (s2.x - s1.x) + d1.y * (s0.x - s2.x) + d2.y * (s1.x - s0.x)) / denominator;
    const f = (d0.y * (s1.x * s2.y - s2.x * s1.y) + d1.y * (s2.x * s0.y - s0.x * s2.y) + d2.y * (s0.x * s1.y - s1.x * s0.y)) / denominator;

    return { a, b, c, d, e, f };
  }

  function drawTexturedTriangle(context, texture, source, destination) {
    if (destination.some(point => !point)) return;
    const transform = affineFromTriangles(source, destination);
    if (!transform) return;

    context.save();
    context.beginPath();
    context.moveTo(destination[0].x, destination[0].y);
    context.lineTo(destination[1].x, destination[1].y);
    context.lineTo(destination[2].x, destination[2].y);
    context.closePath();
    context.clip();
    context.setTransform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    context.drawImage(texture, 0, 0);
    context.restore();
  }

  class GroundMapSource {
    constructor(radar) {
      this.radar = radar;
    }

    map() {
      return this.radar && this.radar.referenceOverlayMap;
    }

    ready() {
      return Boolean(this.map() && this.radar.referenceOverlayReady);
    }

    sync() {
      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    canvas() {
      const map = this.map();
      return map && typeof map.getCanvas === 'function' ? map.getCanvas() : null;
    }

    geographicAt(cssX, cssY) {
      const map = this.map();
      if (!map || typeof map.unproject !== 'function') return null;
      try {
        const position = map.unproject([cssX, cssY]);
        if (!position || !finite(position.lat) || !finite(position.lng)) return null;
        return { latitude: Number(position.lat), longitude: Number(position.lng) };
      } catch (_) {
        return null;
      }
    }

    elevationAt(position) {
      const map = this.map();
      if (!map || !this.ready() || typeof map.queryTerrainElevation !== 'function') return null;
      try {
        const elevation = map.queryTerrainElevation([position.longitude, position.latitude]);
        return finite(elevation) ? Number(elevation) : null;
      } catch (_) {
        return null;
      }
    }
  }

  class SpatialView {
    constructor(radar) {
      if (!radar || !radar.world) throw new Error('SpatialView requires shared world model');
      this.radar = radar;
      this.world = radar.world;
      this.pose = this.world.pose;
      this.root = document.getElementById('threeDView');
      this.scene = document.getElementById('spatialScene');
      this.camera = document.getElementById('spatialCamera');
      this.rangeMeters = this.world.rangeMeters;
      this.active = false;
      this.cameraStream = null;
      this.cameraStarting = false;
      this.cameraHorizontalFov = DEFAULT_HORIZONTAL_FOV_DEGREES;
      this.lastRenderAt = 0;
      this.mapSource = new GroundMapSource(radar);
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();

      this.groundCanvas = document.createElement('canvas');
      this.groundCanvas.className = 'ar-ground-map';
      this.groundCanvas.setAttribute('aria-hidden', 'true');
      this.groundContext = this.groundCanvas.getContext('2d');

      const reticle = document.createElement('div');
      reticle.className = 'spatial-reticle';
      reticle.setAttribute('aria-hidden', 'true');

      const headingReadout = document.createElement('div');
      headingReadout.className = 'spatial-readout spatial-readout-heading';
      headingReadout.innerHTML = 'HDG <span>0°</span>';
      this.headingLabel = headingReadout.querySelector('span');

      const pitchReadout = document.createElement('div');
      pitchReadout.className = 'spatial-readout spatial-readout-pitch';
      pitchReadout.innerHTML = 'EL <span>0°</span>';
      this.pitchLabel = pitchReadout.querySelector('span');

      const rangeReadout = document.createElement('div');
      rangeReadout.className = 'spatial-readout spatial-readout-range';
      rangeReadout.innerHTML = 'R <span>20 m</span>';
      this.rangeLabel = rangeReadout.querySelector('span');

      const cameraReadout = document.createElement('div');
      cameraReadout.className = 'spatial-readout spatial-readout-camera';
      cameraReadout.textContent = 'CAM OFF';
      this.cameraLabel = cameraReadout;

      this.scene.append(this.groundCanvas, reticle, headingReadout, pitchReadout, rangeReadout, cameraReadout);
    }

    setActive(active) {
      const next = Boolean(active);
      if (next === this.active) return;
      this.active = next;
      if (this.active) this.startCamera();
      else this.stopCamera();
    }

    async startCamera() {
      if (!this.active || this.cameraStream || this.cameraStarting || !this.camera) return;
      this.cameraStarting = true;
      if (this.cameraLabel) this.cameraLabel.textContent = 'CAM START';
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('camera API unavailable');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30, max: 30 }
          }
        });
        if (!this.active) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        this.cameraStream = stream;
        this.camera.srcObject = stream;
        this.camera.muted = true;
        this.camera.playsInline = true;
        await this.camera.play();
        if (this.cameraLabel) this.cameraLabel.textContent = 'CAM LIVE';
      } catch (_) {
        if (this.cameraLabel) this.cameraLabel.textContent = 'CAM BLOCKED';
      } finally {
        this.cameraStarting = false;
      }
    }

    stopCamera() {
      if (this.cameraStream) {
        this.cameraStream.getTracks().forEach(track => track.stop());
        this.cameraStream = null;
      }
      if (this.camera) {
        this.camera.pause();
        this.camera.srcObject = null;
      }
      if (this.cameraLabel) this.cameraLabel.textContent = 'CAM OFF';
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
    }

    setGravityVector() {
      // World orientation comes directly from the Android rotation matrix.
    }

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
    }

    effectiveProjection() {
      const width = this.scene ? (this.scene.clientWidth || 320) : 320;
      const height = this.scene ? (this.scene.clientHeight || 320) : 320;
      const videoWidth = this.camera && this.camera.videoWidth ? this.camera.videoWidth : width;
      const videoHeight = this.camera && this.camera.videoHeight ? this.camera.videoHeight : height;
      const sourceAspect = Math.max(0.25, videoWidth / Math.max(1, videoHeight));
      const viewportAspect = Math.max(0.25, width / Math.max(1, height));

      let horizontalFov = this.cameraHorizontalFov * DEG;
      let verticalFov = 2 * Math.atan(Math.tan(horizontalFov * 0.5) / sourceAspect);

      if (viewportAspect > sourceAspect) {
        verticalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * (sourceAspect / viewportAspect));
      } else if (viewportAspect < sourceAspect) {
        horizontalFov = 2 * Math.atan(Math.tan(horizontalFov * 0.5) * (viewportAspect / sourceAspect));
      }

      return {
        width,
        height,
        focalX: (width * 0.5) / Math.tan(horizontalFov * 0.5),
        focalY: (height * 0.5) / Math.tan(verticalFov * 0.5)
      };
    }

    meshVertex(u, v, texture, projection) {
      const cssWidth = texture.clientWidth || texture.width;
      const cssHeight = texture.clientHeight || texture.height;
      if (!cssWidth || !cssHeight || !texture.width || !texture.height) return null;

      const geographic = this.mapSource.geographicAt(u * cssWidth, v * cssHeight);
      if (!geographic) return null;
      const elevation = this.mapSource.elevationAt(geographic);
      if (!finite(elevation)) return null;

      const vector = this.world.geographicVector({
        latitude: geographic.latitude,
        longitude: geographic.longitude,
        altitude: elevation
      });
      if (!vector) return null;

      const point = this.world.camera.project(vector, this.world.pose, projection);
      if (!point) return null;

      return {
        source: { x: u * texture.width, y: v * texture.height },
        destination: { x: point.x, y: point.y },
        vector
      };
    }

    renderGroundMap(projection) {
      if (!this.groundCanvas || !this.groundContext) return;

      const width = Math.max(1, Math.round(projection.width));
      const height = Math.max(1, Math.round(projection.height));
      if (this.groundCanvas.width !== width || this.groundCanvas.height !== height) {
        this.groundCanvas.width = width;
        this.groundCanvas.height = height;
      }
      this.groundContext.setTransform(1, 0, 0, 1, 0, 0);
      this.groundContext.clearRect(0, 0, width, height);

      if (!this.world.pose.hasLocation() || !this.world.pose.hasAltitude() || !this.mapSource.ready()) return;

      this.mapSource.sync();
      const texture = this.mapSource.canvas();
      if (!texture || !texture.width || !texture.height) return;

      const vertices = [];
      for (let row = 0; row <= GROUND_GRID; row += 1) {
        const line = [];
        for (let column = 0; column <= GROUND_GRID; column += 1) {
          line.push(this.meshVertex(column / GROUND_GRID, row / GROUND_GRID, texture, projection));
        }
        vertices.push(line);
      }

      for (let row = 0; row < GROUND_GRID; row += 1) {
        for (let column = 0; column < GROUND_GRID; column += 1) {
          const topLeft = vertices[row][column];
          const topRight = vertices[row][column + 1];
          const bottomLeft = vertices[row + 1][column];
          const bottomRight = vertices[row + 1][column + 1];

          if (topLeft && bottomLeft && topRight) {
            drawTexturedTriangle(
              this.groundContext,
              texture,
              [topLeft.source, bottomLeft.source, topRight.source],
              [topLeft.destination, bottomLeft.destination, topRight.destination]
            );
          }
          if (topRight && bottomLeft && bottomRight) {
            drawTexturedTriangle(
              this.groundContext,
              texture,
              [topRight.source, bottomLeft.source, bottomRight.source],
              [topRight.destination, bottomLeft.destination, bottomRight.destination]
            );
          }
        }
      }
    }

    render(_engine, now = performance.now()) {
      if (!this.active || !this.root || this.root.hidden || !this.scene) return;
      if (now - this.lastRenderAt < FRAME_INTERVAL_MS) return;
      this.lastRenderAt = now;
      this.rangeMeters = this.world.rangeMeters;

      const projection = this.effectiveProjection();
      if (this.headingLabel) this.headingLabel.textContent = `${Math.round(this.world.mapHeadingDegrees())}°`;
      if (this.pitchLabel) {
        const elevation = this.world.camera.cameraElevationDegrees(this.world.pose);
        this.pitchLabel.textContent = `${elevation >= 0 ? '+' : ''}${Math.round(elevation)}°`;
      }
      if (this.rangeLabel) this.rangeLabel.textContent = `${Math.round(this.rangeMeters)} m`;

      this.renderGroundMap(projection);

      // Detection projection is intentionally disabled during the map-only rebuild.
      // this.renderTargets(engine, projection);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();
