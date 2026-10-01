(() => {
  if (!window.WorldSpace || !window.THREE) {
    throw new Error('Spatial engine loaded before WorldSpace/Three');
  }

  const { GeoPoint, Projection, finite } = window.WorldSpace;
  const THREE = window.THREE;
  const BASE_MIXEL_METERS = 2.3;
  const MAX_GRID_CELLS = 100;
  const MESH_REFRESH_MS = 500;

  class SpatialEngine {
    constructor({ world, map, container, video }) {
      if (!world || !map || !container) throw new Error('SpatialEngine requires world, map and container');
      this.world = world;
      this.map = map;
      this.container = container;
      this.video = video || null;
      this.lastMeshAt = 0;
      this.lastMeshWorldVersion = -1;
      this.mode = 'overview';
      this.running = false;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
      this.camera.matrixAutoUpdate = false;
      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.domElement.className = 'spatial-canvas';
      this.container.replaceChildren(this.renderer.domElement);

      this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      this.ground = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      this.scene.add(this.ground);
      this.mapTexture = null;
    }

    terrainElevation(latitude, longitude) {
      if (typeof this.map.queryTerrainElevation !== 'function') return null;
      try {
        const value = this.map.queryTerrainElevation([Number(longitude), Number(latitude)], { exaggerated: false });
        return finite(value) ? Number(value) : null;
      } catch (_) {
        return null;
      }
    }

    resolveObserverGround() {
      const pose = this.world.pose;
      if (!pose.hasLocation()) return false;
      const elevation = this.terrainElevation(pose.latitude, pose.longitude);
      if (!finite(elevation)) return false;
      this.world.resolveGroundElevation(elevation);
      return true;
    }

    metersBetween(a, b) {
      if (!a || !b) return 0;
      const p0 = new GeoPoint(a.lat, a.lng, 0);
      const p1 = new GeoPoint(b.lat, b.lng, 0);
      const meanLat = (p0.latitude + p1.latitude) * 0.5;
      const east = (p1.longitude - p0.longitude) * this.world.metersPerDegreeLongitude(meanLat);
      const north = (p1.latitude - p0.latitude) * window.WorldSpace.METERS_PER_DEGREE_LAT;
      return Math.hypot(east, north);
    }

    gridDimensions(source) {
      const width = Math.max(1, source.clientWidth || source.width || 1);
      const height = Math.max(1, source.clientHeight || source.height || 1);
      let left, right, top, bottom;
      try {
        left = this.map.unproject([0, height * 0.5]);
        right = this.map.unproject([width, height * 0.5]);
        top = this.map.unproject([width * 0.5, 0]);
        bottom = this.map.unproject([width * 0.5, height]);
      } catch (_) {
        return null;
      }
      const groundWidth = this.metersBetween(left, right);
      const groundHeight = this.metersBetween(top, bottom);
      let cellSize = BASE_MIXEL_METERS;
      while (Math.ceil(groundWidth / cellSize) > MAX_GRID_CELLS || Math.ceil(groundHeight / cellSize) > MAX_GRID_CELLS) {
        cellSize *= 2;
      }
      return {
        width,
        height,
        columns: Math.max(1, Math.ceil(groundWidth / cellSize)),
        rows: Math.max(1, Math.ceil(groundHeight / cellSize))
      };
    }

    rebuildGroundMesh() {
      if (!this.world.pose.hasResolvedCamera() || !this.world.origin) return false;
      const source = this.map.getCanvas();
      if (!source || !source.width || !source.height) return false;
      const dims = this.gridDimensions(source);
      if (!dims) return false;

      const { width, height, columns, rows } = dims;
      const positions = [];
      const uvs = [];
      const valid = new Uint8Array((columns + 1) * (rows + 1));

      for (let row = 0; row <= rows; row += 1) {
        const py = height * row / rows;
        for (let col = 0; col <= columns; col += 1) {
          const px = width * col / columns;
          const index = row * (columns + 1) + col;
          let lngLat = null;
          try { lngLat = this.map.unproject([px, py]); } catch (_) {}
          const elevation = lngLat ? this.terrainElevation(lngLat.lat, lngLat.lng) : null;
          const worldPoint = lngLat && finite(elevation)
            ? this.world.terrainWorldPosition(lngLat.lat, lngLat.lng, elevation)
            : null;
          if (worldPoint) {
            positions.push(worldPoint.x, worldPoint.y, worldPoint.z);
            valid[index] = 1;
          } else {
            positions.push(0, 0, 0);
          }
          uvs.push(col / columns, 1 - row / rows);
        }
      }

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
        if ('colorSpace' in this.mapTexture && THREE.SRGBColorSpace) this.mapTexture.colorSpace = THREE.SRGBColorSpace;
        this.material.map = this.mapTexture;
        this.material.needsUpdate = true;
      }
      this.mapTexture.needsUpdate = true;
      return true;
    }

    resize() {
      const width = Math.max(1, this.container.clientWidth || 1);
      const height = Math.max(1, this.container.clientHeight || 1);
      this.renderer.setSize(width, height, false);
      const projection = new Projection(width, height, 60, 0.05, 4000);
      this.camera.aspect = projection.width / projection.height;
      this.camera.fov = projection.verticalFovDegrees;
      this.camera.near = projection.near;
      this.camera.far = projection.far;
      this.camera.updateProjectionMatrix();
    }

    applyArCamera() {
      const position = this.world.observerWorldPosition();
      if (!position || !this.world.pose.orientation.hasMatrix) return false;
      const basis = this.world.cameraBasis();
      const right = new THREE.Vector3(basis.right.x, basis.right.y, basis.right.z);
      const up = new THREE.Vector3(basis.up.x, basis.up.y, basis.up.z);
      const back = new THREE.Vector3(-basis.forward.x, -basis.forward.y, -basis.forward.z);
      this.camera.matrixWorld.makeBasis(right, up, back);
      this.camera.matrixWorld.setPosition(position.x, position.y, position.z);
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.mode = 'ar';
      return true;
    }

    applyOverviewCamera() {
      const observer = this.world.observerWorldPosition();
      if (!observer) return false;
      this.camera.matrixAutoUpdate = true;
      this.camera.position.set(observer.x, observer.y + 38, observer.z - 52);
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(observer.x, observer.y - 5, observer.z + 35);
      this.camera.updateMatrixWorld(true);
      this.camera.matrixAutoUpdate = false;
      this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
      this.mode = 'overview';
      return true;
    }

    applyCamera() {
      return this.world.pose.orientation.hasMatrix ? this.applyArCamera() : this.applyOverviewCamera();
    }

    renderFrame(now) {
      if (!this.running) return;
      this.resize();
      const groundReady = this.resolveObserverGround();
      if (groundReady && (now - this.lastMeshAt >= MESH_REFRESH_MS || this.lastMeshWorldVersion !== this.world.version)) {
        if (this.rebuildGroundMesh()) {
          this.lastMeshAt = now;
          this.lastMeshWorldVersion = this.world.version;
        }
      }
      if (this.mapTexture) this.mapTexture.needsUpdate = true;
      if (groundReady && this.applyCamera()) this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(time => this.renderFrame(time));
    }

    start() {
      if (this.running) return;
      this.running = true;
      requestAnimationFrame(time => this.renderFrame(time));
    }

    stop() {
      this.running = false;
    }
  }

  window.SpatialEngine = SpatialEngine;
})();