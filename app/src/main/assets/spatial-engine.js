(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;
  const BASE_MIXEL_METERS = 2.3;
  const MAX_GRID_CELLS = 128;

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
      if (this.rotatorEl) this.rotatorEl.style.transform = `rotate(${-this.heading}deg) scale(1.18)`;
    }

    setRange(meters) {
      this.world.setRange(meters);
      super.setRange(meters);
    }

    render() {
      if (this.targetLayer) this.targetLayer.replaceChildren();
      if (this.pingLayer) this.pingLayer.replaceChildren();
    }

    ping() { return false; }
  }

  class SpatialView {
    constructor(radar) {
      if (!radar || !radar.world) throw new Error('SpatialView requires shared world model');
      this.radar = radar;
      this.world = radar.world;
      this.pose = this.world.pose;
      this.root = document.getElementById('threeDView');
      this.sceneEl = document.getElementById('spatialScene');
      this.rangeMeters = this.world.rangeMeters;
      this.active = false;
      this.arOrigin = null;
      this.terrainSamples = new Map();
      this.maxTerrainSamples = 512;
      this.ready = false;
      this.initScene();
    }

    async initScene() {
      if (!this.sceneEl) return;
      this.sceneEl.replaceChildren();
      const THREE = await import('https://cdn.jsdelivr.net/npm/three@0.186.1/build/three.module.js');
      this.THREE = THREE;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
      this.camera.matrixAutoUpdate = false;
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.domElement.className = 'spatial-map-mesh';
      this.renderer.domElement.setAttribute('aria-hidden', 'true');
      this.sceneEl.appendChild(this.renderer.domElement);
      this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      this.ground = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      this.scene.add(this.ground);
      this.ready = true;
    }

    referenceMap() {
      return this.radar && this.radar.referenceOverlayMap ? this.radar.referenceOverlayMap : null;
    }

    sourceCanvas() {
      const map = this.referenceMap();
      return map && typeof map.getCanvas === 'function' ? map.getCanvas() : null;
    }

    ensureArOrigin() {
      if (this.arOrigin) return true;
      if (!this.pose.hasLocation() || !this.pose.hasAltitude()) return false;
      this.arOrigin = {
        latitude: Number(this.pose.latitude),
        longitude: Number(this.pose.longitude),
        altitude: Number(this.pose.altitude)
      };
      return true;
    }

    worldPosition(latitude, longitude, altitude) {
      if (!this.arOrigin || !finite(latitude) || !finite(longitude) || !finite(altitude)) return null;
      const meanLatitude = (Number(latitude) + this.arOrigin.latitude) * 0.5 * DEG;
      return {
        x: (Number(longitude) - this.arOrigin.longitude) * METERS_PER_DEGREE_LAT * Math.cos(meanLatitude),
        y: Number(altitude) - this.arOrigin.altitude,
        z: (Number(latitude) - this.arOrigin.latitude) * METERS_PER_DEGREE_LAT
      };
    }

    cameraPosition() {
      return this.worldPosition(this.pose.latitude, this.pose.longitude, Number(this.pose.altitude));
    }

    setActive(active) {
      this.active = Boolean(active);
      if (this.root) this.root.dataset.mapFirst = this.active ? 'true' : 'false';
      if (this.active) this.ensureArOrigin();
      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
      if (this.active) this.ensureArOrigin();
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    setGravityVector() {}

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    terrainElevation(map, lngLat) {
      if (!map || typeof map.queryTerrainElevation !== 'function') return null;
      try {
        const value = map.queryTerrainElevation(lngLat, { exaggerated: false });
        return finite(value) ? Number(value) : null;
      } catch (_) {
        return null;
      }
    }

    terrainSampleKey(lat, lng) {
      return `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
    }

    rememberTerrainSample(lat, lng, elevation) {
      if (!finite(lat) || !finite(lng) || !finite(elevation)) return;
      const key = this.terrainSampleKey(lat, lng);
      this.terrainSamples.set(key, {
        latitude: Number(lat),
        longitude: Number(lng),
        elevation: Number(elevation)
      });
      while (this.terrainSamples.size > this.maxTerrainSamples) {
        this.terrainSamples.delete(this.terrainSamples.keys().next().value);
      }
    }

    seedTerrainSample(map) {
      if (!map || !this.pose.hasLocation()) return false;
      const candidates = [
        { lat: Number(this.pose.latitude), lng: Number(this.pose.longitude) }
      ];
      if (typeof map.getCenter === 'function') {
        try {
          const center = map.getCenter();
          if (center && finite(center.lat) && finite(center.lng)) {
            candidates.push({ lat: Number(center.lat), lng: Number(center.lng) });
          }
        } catch (_) {}
      }
      for (const lngLat of candidates) {
        const elevation = this.terrainElevation(map, lngLat);
        if (finite(elevation)) {
          this.rememberTerrainSample(lngLat.lat, lngLat.lng, elevation);
          return true;
        }
      }
      return this.terrainSamples.size > 0;
    }

    terrainDistanceMeters(lat1, lng1, lat2, lng2) {
      const meanLat = (Number(lat1) + Number(lat2)) * 0.5 * DEG;
      const north = (Number(lat2) - Number(lat1)) * METERS_PER_DEGREE_LAT;
      const east = (Number(lng2) - Number(lng1)) * METERS_PER_DEGREE_LAT * Math.cos(meanLat);
      return Math.hypot(east, north);
    }

    estimateTerrainElevation(lat, lng) {
      const samples = Array.from(this.terrainSamples.values());
      if (!samples.length) return null;
      if (samples.length === 1) return samples[0].elevation;
      const nearest = samples
        .map(sample => ({ sample, distance: this.terrainDistanceMeters(lat, lng, sample.latitude, sample.longitude) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 8);
      if (nearest[0].distance < 0.05) return nearest[0].sample.elevation;
      let weighted = 0;
      let total = 0;
      nearest.forEach(item => {
        const d = Math.max(0.25, item.distance);
        const w = 1 / (d * d);
        weighted += item.sample.elevation * w;
        total += w;
      });
      return total ? weighted / total : null;
    }

    gridDimensions(map, source) {
      const width = Math.max(1, source.clientWidth || source.width);
      const height = Math.max(1, source.clientHeight || source.height);
      let left, right, top, bottom;
      try {
        left = map.unproject([0, height * 0.5]);
        right = map.unproject([width, height * 0.5]);
        top = map.unproject([width * 0.5, 0]);
        bottom = map.unproject([width * 0.5, height]);
      } catch (_) {
        return null;
      }
      const groundWidth = this.terrainDistanceMeters(left.lat, left.lng, right.lat, right.lng);
      const groundHeight = this.terrainDistanceMeters(top.lat, top.lng, bottom.lat, bottom.lng);
      let cellSize = BASE_MIXEL_METERS;
      while (Math.ceil(groundWidth / cellSize) > MAX_GRID_CELLS || Math.ceil(groundHeight / cellSize) > MAX_GRID_CELLS) cellSize *= 2;
      return {
        width,
        height,
        columns: Math.max(1, Math.ceil(groundWidth / cellSize)),
        rows: Math.max(1, Math.ceil(groundHeight / cellSize))
      };
    }

    rebuildGroundMesh() {
      if (!this.ready || !this.ensureArOrigin()) return false;
      const map = this.referenceMap();
      const source = this.sourceCanvas();
      if (!map || !source || !source.width || !source.height) return false;
      this.seedTerrainSample(map);
      const dims = this.gridDimensions(map, source);
      if (!dims) return false;
      const { width, height, columns, rows } = dims;
      const points = [];

      for (let row = 0; row <= rows; row += 1) {
        const py = height * row / rows;
        for (let col = 0; col <= columns; col += 1) {
          const px = width * col / columns;
          let lngLat = null;
          try { lngLat = map.unproject([px, py]); } catch (_) {}
          let elevation = null;
          if (lngLat) {
            elevation = this.terrainElevation(map, lngLat);
            if (finite(elevation)) this.rememberTerrainSample(lngLat.lat, lngLat.lng, elevation);
          }
          points.push({ lngLat, elevation, u: col / columns, v: 1 - row / rows });
        }
      }

      if (!this.terrainSamples.size) return false;

      const positions = [];
      const uvs = [];
      const valid = new Uint8Array(points.length);
      points.forEach((point, index) => {
        const elevation = point.lngLat
          ? (finite(point.elevation) ? point.elevation : this.estimateTerrainElevation(point.lngLat.lat, point.lngLat.lng))
          : null;
        const world = point.lngLat && finite(elevation)
          ? this.worldPosition(point.lngLat.lat, point.lngLat.lng, elevation)
          : null;
        if (world) {
          positions.push(world.x, world.y, world.z);
          valid[index] = 1;
        } else {
          positions.push(0, 0, 0);
        }
        uvs.push(point.u, point.v);
      });

      const indices = [];
      const stride = columns + 1;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < columns; col += 1) {
          const a = row * stride + col;
          const b = a + 1;
          const c = a + stride;
          const d = c + 1;
          if (valid[a] && valid[b] && valid[c]) indices.push(a, c, b);
          if (valid[b] && valid[c] && valid[d]) indices.push(b, c, d);
        }
      }
      if (!indices.length) return false;

      const THREE = this.THREE;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
      geometry.setIndex(indices);
      geometry.computeBoundingSphere();
      this.ground.geometry.dispose();
      this.ground.geometry = geometry;

      if (!this.mapTexture || this.mapTexture.image !== source) {
        if (this.mapTexture) this.mapTexture.dispose();
        this.mapTexture = new THREE.CanvasTexture(source);
        this.mapTexture.colorSpace = THREE.SRGBColorSpace;
        this.material.map = this.mapTexture;
        this.material.needsUpdate = true;
      }
      this.mapTexture.needsUpdate = true;
      return true;
    }

    applyCamera() {
      if (!this.ready || !this.ensureArOrigin()) return false;
      const position = this.cameraPosition();
      if (!position) return false;
      const basis = this.pose.orientation.cameraBasis();
      const THREE = this.THREE;
      const right = new THREE.Vector3(basis.right.x, basis.right.y, basis.right.z);
      const up = new THREE.Vector3(basis.up.x, basis.up.y, basis.up.z);
      const back = new THREE.Vector3(-basis.forward.x, -basis.forward.y, -basis.forward.z);
      this.camera.matrixWorld.makeBasis(right, up, back);
      this.camera.matrixWorld.setPosition(position.x, position.y, position.z);
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      return true;
    }

    resize() {
      if (!this.ready || !this.sceneEl) return;
      const width = Math.max(1, this.sceneEl.clientWidth || 320);
      const height = Math.max(1, this.sceneEl.clientHeight || 320);
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.far = Math.max(100, this.rangeMeters * 4);
      this.camera.updateProjectionMatrix();
    }

    render() {
      if (!this.active || !this.ready) return;
      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
      this.resize();
      if (!this.rebuildGroundMesh()) return;
      if (!this.applyCamera()) return;
      this.renderer.render(this.scene, this.camera);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();