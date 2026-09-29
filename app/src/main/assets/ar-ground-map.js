(() => {
  if (!window.WorldSpace) throw new Error('AR ground map loaded before WorldSpace');

  const { WorldVector3 } = window.WorldSpace;

  function distanceMeters(a, b) {
    if (!a || !b) return Infinity;
    const latMeters = (Number(b.latitude) - Number(a.latitude)) * 111320;
    const meanLat = (Number(a.latitude) + Number(b.latitude)) * 0.5 * Math.PI / 180;
    const lonMeters = (Number(b.longitude) - Number(a.longitude)) * 111320 * Math.cos(meanLat);
    return Math.hypot(latMeters, lonMeters);
  }

  class MapGeometryProvider {
    constructor() {
      this.features = [];
      this.lastCenter = null;
      this.lastRadius = 0;
      this.loading = false;
      this.lastFetchAt = 0;
      this.abortController = null;
    }

    shouldRefresh(center, radiusMeters) {
      if (!center || !Number.isFinite(Number(center.latitude)) || !Number.isFinite(Number(center.longitude))) return false;
      if (!this.lastCenter) return true;
      if (Math.abs(Number(radiusMeters) - this.lastRadius) >= 20) return true;
      return distanceMeters(this.lastCenter, center) >= Math.max(15, Math.min(60, Number(radiusMeters) * 0.25));
    }

    async refresh(center, radiusMeters) {
      const radius = Math.max(30, Math.min(800, Number(radiusMeters) || 100));
      if (!this.shouldRefresh(center, radius) || this.loading) return;
      if (Date.now() - this.lastFetchAt < 2500) return;

      this.loading = true;
      this.lastFetchAt = Date.now();
      if (this.abortController) this.abortController.abort();
      this.abortController = new AbortController();

      const lat = Number(center.latitude);
      const lon = Number(center.longitude);
      const query = `[out:json][timeout:12];(way(around:${Math.ceil(radius)},${lat},${lon})[highway];way(around:${Math.ceil(radius)},${lat},${lon})[building];way(around:${Math.ceil(radius)},${lat},${lon})[railway];way(around:${Math.ceil(radius)},${lat},${lon})[waterway];);out geom;`;
      try {
        const response = await fetch('https://overpass-api.de/api/interpreter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
          body: `data=${encodeURIComponent(query)}`,
          signal: this.abortController.signal
        });
        if (!response.ok) throw new Error(`map geometry HTTP ${response.status}`);
        const payload = await response.json();
        this.features = (Array.isArray(payload.elements) ? payload.elements : [])
          .filter(element => element && element.type === 'way' && Array.isArray(element.geometry) && element.geometry.length >= 2)
          .map(element => ({
            id: String(element.id),
            kind: element.tags && element.tags.highway ? 'road'
              : element.tags && element.tags.building ? 'building'
                : element.tags && element.tags.railway ? 'rail'
                  : element.tags && element.tags.waterway ? 'water'
                    : 'map',
            name: element.tags && (element.tags.name || element.tags.ref) || '',
            points: element.geometry.map(point => ({ latitude: Number(point.lat), longitude: Number(point.lon) }))
          }));
        this.lastCenter = { latitude: lat, longitude: lon };
        this.lastRadius = radius;
      } catch (error) {
        if (error && error.name !== 'AbortError') console.warn('AR map geometry unavailable', error);
      } finally {
        this.loading = false;
      }
    }
  }

  class GroundMapProjection {
    constructor(world, cameraHeightMeters = 1.55) {
      this.world = world;
      this.cameraHeightMeters = cameraHeightMeters;
    }

    vectorFor(position) {
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

    project(position, projection) {
      const vector = this.vectorFor(position);
      return vector ? this.world.camera.project(vector, this.world.pose, projection) : null;
    }
  }

  class ARGroundMapLayer {
    constructor(scene, world) {
      this.scene = scene;
      this.world = world;
      this.provider = new MapGeometryProvider();
      this.ground = new GroundMapProjection(world);
      this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      this.svg.classList.add('ar-ground-map');
      this.svg.setAttribute('aria-hidden', 'true');
      this.scene.prepend(this.svg);
      this.lastRenderedWorldVersion = -1;
      this.lastFeatureSignature = '';
    }

    setCameraHeight(meters) {
      const value = Number(meters);
      if (Number.isFinite(value) && value >= 0.5 && value <= 3) this.ground.cameraHeightMeters = value;
    }

    featureClass(kind) {
      return `ar-ground-map-${kind || 'map'}`;
    }

    featureSignature() {
      const features = this.provider.features;
      if (!features.length) return '0';
      return `${features.length}:${features[0].id}:${features[features.length - 1].id}`;
    }

    render(projection) {
      const pose = this.world.pose;
      if (!pose.hasLocation()) {
        this.svg.replaceChildren();
        return;
      }

      const fetchRadius = Math.max(60, Math.min(800, this.world.rangeMeters * 1.35));
      this.provider.refresh({ latitude: pose.latitude, longitude: pose.longitude }, fetchRadius);

      this.svg.setAttribute('viewBox', `0 0 ${projection.width} ${projection.height}`);
      this.svg.setAttribute('width', String(projection.width));
      this.svg.setAttribute('height', String(projection.height));

      const signature = this.featureSignature();
      if (this.lastRenderedWorldVersion === this.world.version && signature === this.lastFeatureSignature) return;
      this.lastRenderedWorldVersion = this.world.version;
      this.lastFeatureSignature = signature;
      this.svg.replaceChildren();

      this.provider.features.forEach(feature => {
        let segment = [];
        const flush = () => {
          if (segment.length < 2) {
            segment = [];
            return;
          }
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('d', segment.map((point, index) => `${index ? 'L' : 'M'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
          path.setAttribute('class', `ar-ground-map-line ${this.featureClass(feature.kind)}`);
          if (feature.name) path.setAttribute('data-name', feature.name);
          this.svg.appendChild(path);
          segment = [];
        };

        feature.points.forEach(position => {
          const projected = this.ground.project(position, projection);
          if (!projected || projected.depth <= 0.05 || projected.x < -projection.width || projected.x > projection.width * 2 || projected.y < -projection.height || projected.y > projection.height * 2) {
            flush();
            return;
          }
          segment.push(projected);
        });
        flush();
      });
    }
  }

  window.ARGroundMap = { MapGeometryProvider, GroundMapProjection, ARGroundMapLayer };
})();