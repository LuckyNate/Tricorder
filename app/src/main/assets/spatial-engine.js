(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, WorldVector3, wrapDegrees } = window.WorldSpace;
  const DEG = Math.PI / 180;
  const FRAME_INTERVAL_MS = 1000 / 30;
  const DEFAULT_HORIZONTAL_FOV_DEGREES = 70;

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

    setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
      super.setLocation(latitude, longitude, accuracy);
      this.world.setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy);
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

    render() {
      if (this.targetLayer) this.targetLayer.replaceChildren();
      if (this.pingLayer) this.pingLayer.replaceChildren();
    }

    ping() {
      return false;
    }
  }

  class MapGeometrySource {
    constructor(radar) {
      this.radar = radar;
      this.features = [];
      this.lastRefreshAt = 0;
    }

    map() {
      return this.radar && this.radar.referenceOverlayMap;
    }

    refresh(force = false) {
      const map = this.map();
      if (!map || !this.radar.referenceOverlayReady) {
        this.features = [];
        return;
      }

      const now = Date.now();
      if (!force && now - this.lastRefreshAt < 250) return;
      this.lastRefreshAt = now;

      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }

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

            const points = line.map(coordinate => ({
              longitude: Number(coordinate && coordinate[0]),
              latitude: Number(coordinate && coordinate[1])
            })).filter(point => Number.isFinite(point.longitude) && Number.isFinite(point.latitude));
            if (points.length < 2) return;

            const first = points[0];
            const last = points[points.length - 1];
            const id = [
              layer.source,
              layer['source-layer'] || '',
              feature && feature.id != null ? feature.id : featureIndex,
              lineIndex,
              first.longitude.toFixed(6),
              first.latitude.toFixed(6),
              last.longitude.toFixed(6),
              last.latitude.toFixed(6)
            ].join(':');
            if (seen.has(id)) return;
            seen.add(id);

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

    elevationAt(position) {
      const map = this.map();
      if (!map || !this.radar.referenceOverlayReady || typeof map.queryTerrainElevation !== 'function') return null;
      try {
        const elevation = map.queryTerrainElevation([position.longitude, position.latitude]);
        return Number.isFinite(Number(elevation)) ? Number(elevation) : null;
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
      this.mapSource = new MapGeometrySource(radar);
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();

      this.groundSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.groundSvg.classList.add('ar-ground-map');
      this.groundSvg.setAttribute('aria-hidden', 'true');

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

      this.scene.append(this.groundSvg, reticle, headingReadout, pitchReadout, rangeReadout, cameraReadout);
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
      // Mapping rebuild uses the Android rotation matrix directly.
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
      if (!Number.isFinite(Number(this.world.pose.altitude))) return null;
      const horizontal = this.world.horizontalOffset(position);
      const groundAltitude = this.mapSource.elevationAt(position);
      if (!horizontal || !Number.isFinite(Number(groundAltitude))) return null;

      return new WorldVector3({
        east: horizontal.east,
        north: horizontal.north,
        up: Number(groundAltitude) - Number(this.world.pose.altitude),
        horizontalUncertainty: 1,
        verticalUncertainty: 1
      });
    }

    renderGroundMap(projection) {
      if (!this.groundSvg) return;
      if (!this.world.pose.hasLocation() || !Number.isFinite(Number(this.world.pose.altitude))) {
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
          if (!point ||
              point.x < -projection.width || point.x > projection.width * 2 ||
              point.y < -projection.height || point.y > projection.height * 2) {
            flush();
            return;
          }

          segment.push(point);
        });
        flush();
      });
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
