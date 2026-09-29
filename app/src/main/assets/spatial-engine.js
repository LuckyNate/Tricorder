(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, WorldVector3, clamp, wrapDegrees } = window.WorldSpace;
  const DEG = Math.PI / 180;
  const FRAME_INTERVAL_MS = 1000 / 30;
  const DEFAULT_HORIZONTAL_FOV_DEGREES = 70;
  const DEFAULT_CAMERA_HEIGHT_METERS = 1.55;

  function featureKey(layer) {
    return `${layer && layer.id || ''} ${layer && layer['source-layer'] || ''}`.toLowerCase();
  }

  function featureKind(layer) {
    const key = featureKey(layer);
    if (key.includes('rail')) return 'rail';
    if (key.includes('water')) return 'water';
    if (/(road|street|transport|highway|bridge|tunnel|path)/.test(key)) return 'road';
    return 'map';
  }

  function geometryLines(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    switch (geometry.type) {
      case 'LineString': return [geometry.coordinates];
      case 'MultiLineString': return geometry.coordinates;
      case 'Polygon': return geometry.coordinates;
      case 'MultiPolygon': return geometry.coordinates.flat();
      default: return [];
    }
  }

  class SharedRadarView extends BaseRadarView {
    constructor(world = new WorldSpaceModel()) {
      super();
      this.world = world;
      this.world.setRange(this.rangeMeters);
    }

    setLocation(latitude, longitude, accuracy) {
      super.setLocation(latitude, longitude, accuracy);
      const location = this.location || {};
      this.world.setLocation(latitude, longitude, accuracy, location.altitude, location.verticalAccuracy);
    }

    setHeading(degrees) {
      if (!Number.isFinite(Number(degrees))) return;
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

    projectTarget(target) {
      if (!this.location || !target || !this.mapEl) return null;
      const width = this.mapEl.clientWidth || 320;
      const height = this.mapEl.clientHeight || 320;
      return this.world.projectTopDown(target, this.metersPerPixel(), width, height);
    }

    render(engine) {
      if (!this.targetLayer) return;
      this.targetLayer.replaceChildren();
      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;
          const point = this.projectTarget(target);
          if (!point) return;
          const radiusPx = Math.max(0, Number(target.uncertaintyMeters) || 0) / this.metersPerPixel();
          const cloud = document.createElement('div');
          cloud.className = 'target-cloud';
          cloud.style.setProperty('--sensor-color', sensor.color);
          cloud.style.width = `${radiusPx * 2}px`;
          cloud.style.height = `${radiusPx * 2}px`;
          cloud.style.left = `${point.x - radiusPx}px`;
          cloud.style.top = `${point.y - radiusPx}px`;
          cloud.style.opacity = String(clamp(0.2 + (Number(target.confidence) || 0) * 0.62, 0.16, 0.82));
          this.targetLayer.appendChild(cloud);

          if ((Number(target.confidence) || 0) >= 0.62) {
            const dot = document.createElement('div');
            dot.className = 'target-dot';
            dot.style.setProperty('--sensor-color', sensor.color);
            dot.style.left = `${point.x - 4}px`;
            dot.style.top = `${point.y - 4}px`;
            this.targetLayer.appendChild(dot);
          }
        });
      });
    }

    ping(target) {
      if (!target || !target.position || !this.pingLayer) return false;
      const point = this.projectTarget(target);
      if (!point) return false;
      const ripple = document.createElement('div');
      ripple.className = 'target-ripple';
      ripple.style.setProperty('--sensor-color', target.sensor.color);
      ripple.style.left = `${point.x}px`;
      ripple.style.top = `${point.y}px`;
      for (let index = 0; index < 3; index += 1) {
        const ring = document.createElement('span');
        ring.className = 'target-ripple-ring';
        ring.style.animationDelay = `${index * 300}ms`;
        ripple.appendChild(ring);
      }
      this.pingLayer.appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 3000);
      return true;
    }
  }

  class MapGeometrySource {
    constructor(radar) {
      this.radar = radar;
      this.features = [];
      this.lastRefreshAt = 0;
    }

    refresh(force = false) {
      const map = this.radar && this.radar.referenceOverlayMap;
      if (!map || !this.radar.referenceOverlayReady) {
        this.features = [];
        return;
      }
      const now = Date.now();
      if (!force && now - this.lastRefreshAt < 250) return;
      this.lastRefreshAt = now;

      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
      const style = map.getStyle && map.getStyle();
      const layers = style && Array.isArray(style.layers) ? style.layers : [];
      const zoom = typeof map.getZoom === 'function' ? map.getZoom() : 0;
      const next = [];
      const seen = new Set();

      layers.forEach(layer => {
        if (!layer || layer.type !== 'line' || !layer.source) return;
        if (typeof map.getLayoutProperty === 'function' && map.getLayoutProperty(layer.id, 'visibility') === 'none') return;
        if (Number.isFinite(Number(layer.minzoom)) && zoom < Number(layer.minzoom)) return;
        if (Number.isFinite(Number(layer.maxzoom)) && zoom >= Number(layer.maxzoom)) return;

        const options = {};
        if (layer['source-layer']) options.sourceLayer = layer['source-layer'];
        if (layer.filter) options.filter = layer.filter;

        let sourceFeatures = [];
        try {
          sourceFeatures = map.querySourceFeatures(layer.source, options) || [];
        } catch (_) {
          return;
        }

        sourceFeatures.forEach((feature, featureIndex) => {
          geometryLines(feature && feature.geometry).forEach((line, lineIndex) => {
            if (!Array.isArray(line) || line.length < 2) return;
            const id = `${layer.source}:${layer['source-layer'] || ''}:${feature && feature.id != null ? feature.id : featureIndex}:${lineIndex}`;
            if (seen.has(id)) return;
            seen.add(id);
            const points = line.map(coordinate => ({
              longitude: Number(coordinate && coordinate[0]),
              latitude: Number(coordinate && coordinate[1])
            })).filter(point => Number.isFinite(point.longitude) && Number.isFinite(point.latitude));
            if (points.length < 2) return;
            next.push({
              id,
              kind: featureKind(layer),
              name: feature && feature.properties && (feature.properties.name || feature.properties.ref) || '',
              points
            });
          });
        });
      });

      this.features = next;
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
      this.cameraHeightMeters = DEFAULT_CAMERA_HEIGHT_METERS;
      this.lastRenderAt = 0;
      this.nodes = new Map();
      this.mapSource = new MapGeometrySource(radar);
      this.gravityVector = null;
      this.gravityDisplayRotation = 0;
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();

      this.groundSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.groundSvg.classList.add('ar-ground-map');
      this.groundSvg.setAttribute('aria-hidden', 'true');

      this.horizon = document.createElement('div');
      this.horizon.className = 'spatial-horizon';
      this.horizon.setAttribute('aria-hidden', 'true');

      this.targetLayer = document.createElement('div');
      this.targetLayer.id = 'spatialTargets';

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

      this.scene.append(this.groundSvg, this.horizon, this.targetLayer, reticle, headingReadout, pitchReadout, rangeReadout, cameraReadout);
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

    setGravityVector(vector, displayRotation = 0) {
      if (!Array.isArray(vector) || vector.length !== 3 || !vector.every(value => Number.isFinite(Number(value)))) return;
      this.gravityVector = vector.map(Number);
      this.gravityDisplayRotation = Number(displayRotation) || 0;
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

    groundVector(position) {
      const horizontal = this.world.horizontalOffset(position);
      if (!horizontal) return null;
      return new WorldVector3({
        east: horizontal.east,
        north: horizontal.north,
        up: -this.cameraHeightMeters,
        horizontalUncertainty: 1,
        verticalUncertainty: 1
      });
    }

    renderGroundMap(projection) {
      if (!this.groundSvg) return;
      if (!this.world.pose.hasLocation()) {
        this.groundSvg.replaceChildren();
        return;
      }

      this.mapSource.refresh();
      this.groundSvg.setAttribute('viewBox', `0 0 ${projection.width} ${projection.height}`);
      this.groundSvg.setAttribute('width', String(projection.width));
      this.groundSvg.setAttribute('height', String(projection.height));
      this.groundSvg.replaceChildren();

      const maxDistance = Math.max(30, this.rangeMeters * 1.75);
      this.mapSource.features.forEach(feature => {
        let segment = [];
        const flush = () => {
          if (segment.length >= 2) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
            path.setAttribute('class', `ar-ground-map-line ar-ground-map-${feature.kind || 'map'}`);
            if (feature.name) path.setAttribute('data-name', feature.name);
            this.groundSvg.appendChild(path);
          }
          segment = [];
        };

        feature.points.forEach(position => {
          const vector = this.groundVector(position);
          if (!vector || vector.horizontalDistance > maxDistance) {
            flush();
            return;
          }
          const point = this.world.camera.project(vector, this.world.pose, projection);
          if (!point || point.depth <= 0.05 || point.x < -projection.width || point.x > projection.width * 2 || point.y < -projection.height || point.y > projection.height * 2) {
            flush();
            return;
          }
          segment.push(point);
        });
        flush();
      });
    }

    renderHorizon(projection) {
      if (!this.horizon) return;
      const pose = this.world.pose;
      const basis = pose.orientation && pose.orientation.hasMatrix ? pose.orientation.cameraBasis() : null;
      if (!basis) {
        const elevation = this.world.camera.cameraElevationDegrees(pose) * DEG;
        const roll = this.world.camera.cameraRollDegrees(pose);
        this.horizon.style.display = 'block';
        this.horizon.style.transform = `translate3d(0,${Math.tan(elevation) * projection.focalY}px,0) rotate(${roll}deg)`;
        return;
      }

      const upRight = basis.right.up;
      const upScreen = basis.up.up;
      const upForward = basis.forward.up;
      if (Math.abs(upScreen) < 0.001) {
        this.horizon.style.display = 'none';
        return;
      }
      const offset = projection.focalY * upForward / upScreen;
      const angle = Math.atan(projection.focalY * upRight / (projection.focalX * upScreen)) / DEG;
      this.horizon.style.display = 'block';
      this.horizon.style.transform = `translate3d(0,${offset}px,0) rotate(${angle}deg)`;
    }

    ensureNode(key, sensor) {
      let node = this.nodes.get(key);
      if (node) return node;
      const cloud = document.createElement('div');
      cloud.className = 'spatial-target-cloud';
      cloud.style.setProperty('--sensor-color', sensor.color);
      const dot = document.createElement('div');
      dot.className = 'spatial-target-dot';
      dot.style.setProperty('--sensor-color', sensor.color);
      cloud.appendChild(dot);
      this.targetLayer.appendChild(cloud);
      node = { cloud, dot, seen: false };
      this.nodes.set(key, node);
      return node;
    }

    renderTargets(engine, projection) {
      this.nodes.forEach(node => { node.seen = false; });

      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;
          const vector = this.world.resolveTarget(target);
          if (!vector) return;
          if (vector.distance - Math.max(vector.horizontalUncertainty, vector.verticalUncertainty) > this.rangeMeters) return;

          const projected = this.world.camera.project(vector, this.world.pose, projection);
          if (!projected) return;

          const radiusX = clamp(
            Math.atan2(vector.horizontalUncertainty, Math.max(0.5, projected.depth)) * projected.focalX,
            8,
            projected.width * 0.48
          );
          const radiusY = clamp(
            Math.atan2(vector.verticalUncertainty, Math.max(0.5, projected.depth)) * projected.focalY,
            8,
            projected.height * 0.48
          );

          if (projected.x < -radiusX || projected.x > projected.width + radiusX || projected.y < -radiusY || projected.y > projected.height + radiusY) return;

          const key = `${sensor.id}:${target.id}`;
          const node = this.ensureNode(key, sensor);
          node.seen = true;
          const confidence = clamp(Number(target.confidence) || 0, 0, 1);
          const ageMs = Math.max(0, Date.now() - (Number(target.lastReceivedAt) || Date.now()) + (Number(target.sampleAgeMs) || 0));
          const freshness = clamp(1 - ageMs / 30000, 0.25, 1);
          const opacity = clamp((0.22 + confidence * 0.68) * freshness, 0.12, 0.90);

          node.cloud.style.width = `${radiusX * 2}px`;
          node.cloud.style.height = `${radiusY * 2}px`;
          node.cloud.style.transform = `translate3d(${projected.x - radiusX}px,${projected.y - radiusY}px,0)`;
          node.cloud.style.opacity = String(opacity);
          node.cloud.style.zIndex = String(Math.max(1, Math.round(10000 - projected.depth * 10)));
          node.cloud.style.display = 'block';
          node.cloud.title = `${target.name || target.id} · ${Math.round(vector.distance)}m · uncertainty ${Math.round(vector.horizontalUncertainty)}m × ${Math.round(vector.verticalUncertainty)}m`;
          node.dot.style.display = confidence >= 0.62 ? 'block' : 'none';
        });
      });

      this.nodes.forEach((node, key) => {
        if (!node.seen) {
          node.cloud.remove();
          this.nodes.delete(key);
        }
      });
    }

    render(engine, now = performance.now()) {
      if (!this.active || !this.root || this.root.hidden || !this.scene || !this.targetLayer) return;
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
      this.renderHorizon(projection);
      this.renderTargets(engine, projection);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();
