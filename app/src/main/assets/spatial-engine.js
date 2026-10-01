(() => {
  if (!window.WorldSpace || !window.THREE) {
    throw new Error('Spatial engine loaded before WorldSpace/Three');
  }

  const { GeoPoint, Projection, finite } = window.WorldSpace;
  const THREE = window.THREE;

  const BASE_MIXEL_METERS = 2.3;
  const MAX_GRID_CELLS = 100;
  const MESH_REFRESH_MS = 1000;
  const MIN_BOOM_METERS = 2;
  const MAX_BOOM_METERS = 30000;
  const DEFAULT_BOOM_METERS = 18;
  const BOOM_ELEVATION_DEGREES = 25;

  class SpatialEngine {
    constructor({ world, map, container, video }) {
      if (!world || !map || !container) throw new Error('SpatialEngine requires world, map and container');

      this.world = world;
      this.map = map;
      this.container = container;
      this.video = video || null;
      this.mode = 'third-person';
      this.running = false;

      this.boomMeters = DEFAULT_BOOM_METERS;
      this.activePointers = new Map();
      this.lastPinchDistance = null;

      this.lastMeshAt = -Infinity;
      this.lastMeshLatitude = null;
      this.lastMeshLongitude = null;
      this.mapTexture = null;

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 4000);
      this.camera.matrixAutoUpdate = true;

      this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.domElement.className = 'spatial-canvas';
      this.renderer.domElement.style.touchAction = 'none';
      this.container.replaceChildren(this.renderer.domElement);

      this.material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
      this.ground = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
      this.scene.add(this.ground);

      this.bindBoomControls();
    }

    bindBoomControls() {
      const canvas = this.renderer.domElement;

      canvas.addEventListener('pointerdown', event => {
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try { canvas.setPointerCapture(event.pointerId); } catch (_) {}
        this.lastPinchDistance = this.currentPinchDistance();
      });

      canvas.addEventListener('pointermove', event => {
        if (!this.activePointers.has(event.pointerId)) return;
        this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.activePointers.size !== 2) return;

        const distance = this.currentPinchDistance();
        if (!finite(distance) || distance <= 0) return;

        if (finite(this.lastPinchDistance) && this.lastPinchDistance > 0) {
          const scale = distance / this.lastPinchDistance;
          this.boomMeters = THREE.MathUtils.clamp(
            this.boomMeters / scale,
            MIN_BOOM_METERS,
            MAX_BOOM_METERS
          );
        }
        this.lastPinchDistance = distance;
      });

      const endPointer = event => {
        this.activePointers.delete(event.pointerId);
        this.lastPinchDistance = this.currentPinchDistance();
      };

      canvas.addEventListener('pointerup', endPointer);
      canvas.addEventListener('pointercancel', endPointer);
      canvas.addEventListener('lostpointercapture', endPointer);
    }

    currentPinchDistance() {
      if (this.activePointers.size !== 2) return null;
      const points = Array.from(this.activePointers.values());
      return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
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

    terrainSourceReady() {
      try {
        return typeof this.map.isSourceLoaded === 'function' && this.map.isSourceLoaded('tricorder-terrain');
      } catch (_) {
        return false;
      }
    }

    terrainElevation(latitude, longitude) {
      if (!this.terrainSourceReady() || typeof this.map.queryTerrainElevation !== 'function') return null;
      try {
        const value = this.map.queryTerrainElevation(
          [Number(longitude), Number(latitude)],
          { exaggerated: false }
        );
        return finite(value) ? Number(value) : null;
      } catch (_) {
        return null;
      }
    }

    groundFallbackElevation() {
      const pose = this.world.pose;
      return finite(pose.groundElevationMSL) ? Number(pose.groundElevationMSL) : null;
    }

    resolveObserverGround() {
      const pose = this.world.pose;
      if (!pose.hasLocation()) return false;

      const terrain = this.terrainElevation(pose.latitude, pose.longitude);
      const previousGround = this.groundFallbackElevation();
      const elevation = finite(terrain) ? terrain : previousGround;
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
      let left;
      let right;
      let top;
      let bottom;

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

      while (
        Math.ceil(groundWidth / cellSize) > MAX_GRID_CELLS ||
        Math.ceil(groundHeight / cellSize) > MAX_GRID_CELLS
      ) {
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
      const pose = this.world.pose;
      if (!pose.hasResolvedCamera() || !this.world.origin) return false;

      const source = this.map.getCanvas();
      if (!source || !source.width || !source.height) return false;

      const dims = this.gridDimensions(source);
      if (!dims) return false;

      const fallbackElevation = this.groundFallbackElevation();
      if (!finite(fallbackElevation)) return false;

      const { width, height, columns, rows } = dims;
      const positions = [];
      const uvs = [];
      const valid = new Uint8Array((columns + 1) * (rows + 1));
      const terrainReady = this.terrainSourceReady();

      for (let row = 0; row <= rows; row += 1) {
        const py = height * row / rows;
        for (let col = 0; col <= columns; col += 1) {
          const px = width * col / columns;
          const index = row * (columns + 1) + col;
          let lngLat = null;

          try {
            lngLat = this.map.unproject([px, py]);
          } catch (_) {}

          if (!lngLat) {
            positions.push(0, 0, 0);
            uvs.push(col / columns, 1 - row / rows);
            continue;
          }

          const terrain = terrainReady ? this.terrainElevation(lngLat.lat, lngLat.lng) : null;
          const elevation = finite(terrain) ? terrain : fallbackElevation;
          const worldPoint = this.world.terrainWorldPosition(lngLat.lat, lngLat.lng, elevation);

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
        if ('colorSpace' in this.mapTexture && THREE.SRGBColorSpace) {
          this.mapTexture.colorSpace = THREE.SRGBColorSpace;
        }
        this.material.map = this.mapTexture;
        this.material.needsUpdate = true;
      }

      this.mapTexture.needsUpdate = true;
      this.lastMeshLatitude = pose.latitude;
      this.lastMeshLongitude = pose.longitude;
      return true;
    }

    subjectMovedEnoughForMesh() {
      const pose = this.world.pose;
      if (!pose.hasLocation()) return false;
      if (!finite(this.lastMeshLatitude) || !finite(this.lastMeshLongitude)) return true;

      return this.metersBetween(
        { lat: this.lastMeshLatitude, lng: this.lastMeshLongitude },
        { lat: pose.latitude, lng: pose.longitude }
      ) >= BASE_MIXEL_METERS;
    }

    applyThirdPersonCamera() {
      const subject = this.world.observerWorldPosition();
      if (!subject) return false;

      const heading = this.world.pose.heading * Math.PI / 180;
      const elevation = BOOM_ELEVATION_DEGREES * Math.PI / 180;
      const horizontal = this.boomMeters * Math.cos(elevation);
      const vertical = this.boomMeters * Math.sin(elevation);

      const forwardX = Math.sin(heading);
      const forwardZ = Math.cos(heading);

      this.camera.position.set(
        subject.x - forwardX * horizontal,
        subject.y + vertical,
        subject.z - forwardZ * horizontal
      );
      this.camera.up.set(0, 1, 0);
      this.camera.lookAt(subject.x, subject.y, subject.z);
      this.camera.updateMatrixWorld(true);
      return true;
    }

    renderFrame(now) {
      if (!this.running) return;

      this.resize();
      this.resolveObserverGround();

      const subjectReady = this.world.pose.hasResolvedCamera() && !!this.world.origin;
      const meshDue = now - this.lastMeshAt >= MESH_REFRESH_MS;

      if (subjectReady && meshDue && (this.subjectMovedEnoughForMesh() || !this.mapTexture)) {
        if (this.rebuildGroundMesh()) this.lastMeshAt = now;
      }

      if (this.mapTexture) this.mapTexture.needsUpdate = true;

      if (subjectReady && this.applyThirdPersonCamera()) {
        this.renderer.render(this.scene, this.camera);
      }

      requestAnimationFrame(time => this.renderFrame(time));
    }

    start() {
      if (this.running) return;
      this.running = true;
      requestAnimationFrame(time => this.renderFrame(time));
    }

    stop() {
      this.running = false;
      this.activePointers.clear();
      this.lastPinchDistance = null;
    }
  }

  window.SpatialEngine = SpatialEngine;
})();