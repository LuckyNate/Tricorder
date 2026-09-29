(() => {
  if (!window.WorldSpace) throw new Error('AR ground map loaded before WorldSpace');

  const { WorldVector3 } = window.WorldSpace;

  function layerKey(layer) {
    return `${layer && layer.id || ''} ${layer && layer['source-layer'] || ''}`.toLowerCase();
  }

  function featureKind(feature) {
    const key = layerKey(feature && feature.layer);
    if (key.includes('rail')) return 'rail';
    if (key.includes('water')) return 'water';
    if (/(road|street|transport|highway|bridge|tunnel|path)/.test(key)) return 'road';
    return 'map';
  }

  function geometryLines(geometry) {
    if (!geometry || !Array.isArray(geometry.coordinates)) return [];
    switch (geometry.type) {
      case 'LineString':
        return [geometry.coordinates];
      case 'MultiLineString':
        return geometry.coordinates;
      case 'Polygon':
        return geometry.coordinates;
      case 'MultiPolygon':
        return geometry.coordinates.flat();
      default:
        return [];
    }
  }

  class MapGeometryProvider {
    constructor(radar) {
      this.radar = radar;
      this.features = [];
      this.lastReadAt = 0;
    }

    refresh() {
      const map = this.radar && this.radar.referenceOverlayMap;
      if (!map || !this.radar.referenceOverlayReady) {
        this.features = [];
        return;
      }

      if (Date.now() - this.lastReadAt < 250) return;
      this.lastReadAt = Date.now();

      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();

      let rendered;
      try {
        rendered = map.queryRenderedFeatures();
      } catch (error) {
        console.warn('AR map features unavailable', error);
        return;
      }

      const next = [];
      const seen = new Set();
      (Array.isArray(rendered) ? rendered : []).forEach((feature, featureIndex) => {
        if (!feature || !feature.layer || feature.layer.type !== 'line') return;
        const lines = geometryLines(feature.geometry);
        lines.forEach((line, lineIndex) => {
          if (!Array.isArray(line) || line.length < 2) return;
          const id = `${feature.layer.id}:${feature.id == null ? featureIndex : feature.id}:${lineIndex}`;
          if (seen.has(id)) return;
          seen.add(id);

          const points = line.map(coordinate => ({
            latitude: Number(coordinate && coordinate[1]),
            longitude: Number(coordinate && coordinate[0])
          })).filter(point => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
          if (points.length < 2) return;

          next.push({
            id,
            kind: featureKind(feature),
            name: feature.properties && (feature.properties.name || feature.properties.ref) || '',
            points
          });
        });
      });
      this.features = next;
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
    constructor(scene, world, radar) {
      this.scene = scene;
      this.world = world;
      this.provider = new MapGeometryProvider(radar);
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

      this.provider.refresh();

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

  if (window.SpatialView) {
    const BaseSpatialView = window.SpatialView;
    class GroundMappedSpatialView extends BaseSpatialView {
      constructor(radar) {
        super(radar);
        this.groundMap = this.scene && radar && radar.world
          ? new ARGroundMapLayer(this.scene, radar.world, radar)
          : null;
      }

      render(engine, now = performance.now()) {
        if (this.active && this.groundMap && this.scene && !this.root.hidden) {
          this.groundMap.render(this.effectiveProjection());
        }
        super.render(engine, now);
      }
    }
    window.SpatialView = GroundMappedSpatialView;
  }
})();