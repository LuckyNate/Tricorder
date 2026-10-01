(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;
  const BASE_MIXEL_METERS = 2.3;
  const BASE_MAP_PIXELS = 10;
  const MAX_MIXEL_LOD = 6;
  const MAX_MESH_DEPTH = 10;

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

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'shader compile failed';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function createProgram(gl) {
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
      attribute vec3 aWorldPosition;
      attribute vec2 aUv;
      uniform vec3 uCameraPosition;
      uniform vec3 uCameraRight;
      uniform vec3 uCameraUp;
      uniform vec3 uCameraForward;
      uniform float uAspect;
      uniform float uFar;
      varying vec2 vUv;

      void main() {
        vec3 delta = aWorldPosition - uCameraPosition;
        vec3 camera = vec3(
          dot(delta, uCameraRight),
          dot(delta, uCameraUp),
          dot(delta, uCameraForward)
        );
        float f = 1.7320508;
        float nearPlane = 0.05;
        float farPlane = max(uFar, nearPlane + 1.0);
        float z = camera.z;
        gl_Position = vec4(
          camera.x * f / uAspect,
          camera.y * f,
          ((farPlane + nearPlane) / (farPlane - nearPlane)) * z -
            ((2.0 * farPlane * nearPlane) / (farPlane - nearPlane)),
          z
        );
        vUv = aUv;
      }
    `);

    const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
      precision mediump float;
      varying vec2 vUv;
      uniform sampler2D uMap;
      void main() { gl_FragColor = texture2D(uMap, vUv); }
    `);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'program link failed';
      gl.deleteProgram(program);
      throw new Error(message);
    }
    return program;
  }

  class SpatialView {
    constructor(radar) {
      if (!radar || !radar.world) throw new Error('SpatialView requires shared world model');
      this.radar = radar;
      this.world = radar.world;
      this.pose = this.world.pose;
      this.root = document.getElementById('threeDView');
      this.scene = document.getElementById('spatialScene');
      this.rangeMeters = this.world.rangeMeters;
      this.active = false;
      this.gl = null;
      this.program = null;
      this.texture = null;
      this.vertexBuffer = null;
      this.indexBuffer = null;
      this.indexCount = 0;
      this.terrainSamples = new Map();
      this.maxTerrainSamples = 32768;
      this.tileImages = new Map();
      this.arOrigin = null;
      this.meshDirty = true;
      this.lastMeshAttempt = 0;
      this.lastTerrainRefresh = 0;
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();
      this.canvas = document.createElement('canvas');
      this.canvas.className = 'spatial-map-mesh';
      this.canvas.setAttribute('aria-hidden', 'true');
      this.scene.appendChild(this.canvas);

      const gl = this.canvas.getContext('webgl', {
        alpha: true,
        antialias: true,
        depth: true,
        premultipliedAlpha: false
      });
      if (!gl) throw new Error('WebGL unavailable for 3D map mesh');
      this.gl = gl;
      this.program = createProgram(gl);
      this.vertexBuffer = gl.createBuffer();
      this.indexBuffer = gl.createBuffer();

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      const positionLocation = gl.getAttribLocation(this.program, 'aWorldPosition');
      const uvLocation = gl.getAttribLocation(this.program, 'aUv');
      const stride = 5 * Float32Array.BYTES_PER_ELEMENT;
      gl.enableVertexAttribArray(positionLocation);
      gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(uvLocation);
      gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, stride, 3 * Float32Array.BYTES_PER_ELEMENT);

      this.texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      this.stagingCanvas = document.createElement('canvas');
      this.stagingContext = this.stagingCanvas.getContext('2d');

      gl.useProgram(this.program);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uMap'), 0);
      this.uniforms = {
        cameraPosition: gl.getUniformLocation(this.program, 'uCameraPosition'),
        cameraRight: gl.getUniformLocation(this.program, 'uCameraRight'),
        cameraUp: gl.getUniformLocation(this.program, 'uCameraUp'),
        cameraForward: gl.getUniformLocation(this.program, 'uCameraForward'),
        aspect: gl.getUniformLocation(this.program, 'uAspect'),
        far: gl.getUniformLocation(this.program, 'uFar')
      };

      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.disable(gl.CULL_FACE);
      gl.clearColor(0, 0, 0, 0);
    }

    referenceMap() {
      return this.radar && this.radar.referenceOverlayMap ? this.radar.referenceOverlayMap : null;
    }

    ensureArOrigin() {
      if (this.arOrigin) return true;
      if (!this.pose.hasLocation() || !this.pose.hasAltitude()) return false;
      this.arOrigin = {
        latitude: Number(this.pose.latitude),
        longitude: Number(this.pose.longitude),
        altitude: Number(this.pose.altitude)
      };
      this.meshDirty = true;
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
      return this.worldPosition(this.pose.latitude, this.pose.longitude, this.pose.altitude);
    }

    resize() {
      if (!this.canvas || !this.scene || !this.gl) return;
      const width = Math.max(1, Math.round(this.scene.clientWidth || 320));
      const height = Math.max(1, Math.round(this.scene.clientHeight || 320));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      this.gl.viewport(0, 0, width, height);
      this.gl.useProgram(this.program);
      this.gl.uniform1f(this.uniforms.aspect, width / height);
      this.gl.uniform1f(this.uniforms.far, Math.max(100, this.rangeMeters * 3));
    }

    setActive(active) {
      this.active = Boolean(active);
      if (this.root) this.root.dataset.mapFirst = this.active ? 'true' : 'false';
      if (this.active) {
        this.ensureArOrigin();
        this.meshDirty = true;
      }
      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    setPose(values = {}) {
      const oldLat = this.pose.latitude;
      const oldLon = this.pose.longitude;
      const oldAlt = this.pose.altitude;
      this.world.setPose(values);
      this.pose = this.world.pose;
      if (this.active) this.ensureArOrigin();
      if (oldLat !== this.pose.latitude || oldLon !== this.pose.longitude || oldAlt !== this.pose.altitude) {
        this.meshDirty = true;
      }
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
    }

    setGravityVector() {}

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
      this.meshDirty = true;
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
        const oldestKey = this.terrainSamples.keys().next().value;
        this.terrainSamples.delete(oldestKey);
      }
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
      if (nearest[0] && nearest[0].distance < 0.05) return nearest[0].sample.elevation;
      let weightedElevation = 0;
      let totalWeight = 0;
      nearest.forEach(item => {
        const distance = Math.max(0.25, item.distance);
        const weight = 1 / (distance * distance);
        weightedElevation += item.sample.elevation * weight;
        totalWeight += weight;
      });
      return totalWeight > 0 ? weightedElevation / totalWeight : null;
    }

    inverseWorldY(worldY, zoom) {
      const worldSize = this.radar.tileSize * Math.pow(2, zoom);
      const n = Math.PI - (2 * Math.PI * worldY) / worldSize;
      return Math.atan(Math.sinh(n)) / DEG;
    }

    mapPixelToLngLat(px, py, width, height) {
      if (!this.radar.location) return null;
      const zoom = this.radar.zoom;
      const scale = this.radar.scale || 1;
      const centerX = this.radar.lonToWorldX(this.radar.location.longitude, zoom);
      const centerY = this.radar.latToWorldY(this.radar.location.latitude, zoom);
      const worldX = centerX + (px - width * 0.5) / scale;
      const worldY = centerY + (py - height * 0.5) / scale;
      const worldSize = this.radar.tileSize * Math.pow(2, zoom);
      return {
        lng: worldX / worldSize * 360 - 180,
        lat: this.inverseWorldY(worldY, zoom)
      };
    }

    tileImage(source) {
      if (!source || !source.src) return null;
      let entry = this.tileImages.get(source.src);
      if (entry) return entry;
      const image = new Image();
      entry = { image, ready: false, failed: false };
      this.tileImages.set(source.src, entry);
      image.crossOrigin = 'anonymous';
      image.onload = () => { entry.ready = true; };
      image.onerror = () => { entry.failed = true; };
      image.src = source.src;
      return entry;
    }

    rebuildMapTexture() {
      if (!this.radar.mapEl || !this.stagingContext || !this.radar.tiles) return false;
      const width = Math.max(1, Math.round(this.radar.mapEl.clientWidth || 320));
      const height = Math.max(1, Math.round(this.radar.mapEl.clientHeight || 320));
      if (this.stagingCanvas.width !== width || this.stagingCanvas.height !== height) {
        this.stagingCanvas.width = width;
        this.stagingCanvas.height = height;
      }
      this.stagingContext.clearRect(0, 0, width, height);
      let drawn = 0;
      this.radar.tiles.forEach(source => {
        const entry = this.tileImage(source);
        if (!entry || !entry.ready || entry.failed) return;
        const left = Number.parseFloat(source.style.left);
        const top = Number.parseFloat(source.style.top);
        const tileWidth = Number.parseFloat(source.style.width);
        const tileHeight = Number.parseFloat(source.style.height);
        if (![left, top, tileWidth, tileHeight].every(Number.isFinite)) return;
        this.stagingContext.drawImage(entry.image, left, top, tileWidth, tileHeight);
        drawn += 1;
      });
      return drawn > 0;
    }

    cellDistanceMeters(x0, y0, x1, y1, width, height, metersPerPixel) {
      const centerX = width * 0.5;
      const centerY = height * 0.5;
      const dx = centerX < x0 ? x0 - centerX : (centerX > x1 ? centerX - x1 : 0);
      const dy = centerY < y0 ? y0 - centerY : (centerY > y1 ? centerY - y1 : 0);
      return Math.hypot(dx, dy) * metersPerPixel;
    }

    desiredMixelMeters(distanceMeters) {
      const ratio = Math.max(1, distanceMeters / (BASE_MIXEL_METERS * 8));
      const lod = Math.max(0, Math.min(MAX_MIXEL_LOD, Math.floor(Math.log2(ratio))));
      return BASE_MIXEL_METERS * Math.pow(2, lod);
    }

    buildMixelCells(width, height) {
      const metersPerPixel = Math.max(0.001, Number(this.radar.metersPerPixel()) || (BASE_MIXEL_METERS / BASE_MAP_PIXELS));
      const cells = [];
      const split = (x0, y0, x1, y1, depth) => {
        const cellWidthMeters = (x1 - x0) * metersPerPixel;
        const cellHeightMeters = (y1 - y0) * metersPerPixel;
        const distance = this.cellDistanceMeters(x0, y0, x1, y1, width, height, metersPerPixel);
        const target = this.desiredMixelMeters(distance);
        if (depth >= MAX_MESH_DEPTH || (cellWidthMeters <= target && cellHeightMeters <= target)) {
          cells.push({ x0, y0, x1, y1 });
          return;
        }
        const mx = (x0 + x1) * 0.5;
        const my = (y0 + y1) * 0.5;
        split(x0, y0, mx, my, depth + 1);
        split(mx, y0, x1, my, depth + 1);
        split(x0, my, mx, y1, depth + 1);
        split(mx, my, x1, y1, depth + 1);
      };
      split(0, 0, width, height, 0);
      return cells;
    }

    rebuildGroundMesh() {
      const map = this.referenceMap();
      if (!map || !this.radar.mapEl || !this.radar.location) return false;
      if (!this.ensureArOrigin()) return false;

      const width = Math.max(1, this.radar.mapEl.clientWidth || 320);
      const height = Math.max(1, this.radar.mapEl.clientHeight || 320);
      const cells = this.buildMixelCells(width, height);
      const vertexMap = new Map();
      const vertices = [];
      const indices = [];

      const vertexFor = (px, py) => {
        const key = `${px.toFixed(4)},${py.toFixed(4)}`;
        if (vertexMap.has(key)) return vertexMap.get(key);
        const lngLat = this.mapPixelToLngLat(px, py, width, height);
        if (!lngLat) return -1;
        let elevation = this.terrainElevation(map, lngLat);
        if (finite(elevation)) this.rememberTerrainSample(lngLat.lat, lngLat.lng, elevation);
        if (!finite(elevation)) elevation = this.estimateTerrainElevation(lngLat.lat, lngLat.lng);
        if (!finite(elevation)) return -1;
        const world = this.worldPosition(lngLat.lat, lngLat.lng, elevation);
        if (!world || !finite(world.x) || !finite(world.y) || !finite(world.z)) return -1;
        const index = vertices.length / 5;
        if (index >= 65535) return -1;
        vertices.push(world.x, world.y, world.z, px / width, py / height);
        vertexMap.set(key, index);
        return index;
      };

      cells.forEach(cell => {
        const a = vertexFor(cell.x0, cell.y0);
        const b = vertexFor(cell.x1, cell.y0);
        const c = vertexFor(cell.x0, cell.y1);
        const d = vertexFor(cell.x1, cell.y1);
        if (a < 0 || b < 0 || c < 0 || d < 0) return;
        indices.push(a, b, c, c, b, d);
      });

      if (!indices.length) return false;
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.DYNAMIC_DRAW);
      this.indexCount = indices.length;
      this.meshDirty = false;
      this.lastTerrainRefresh = performance.now();
      return true;
    }

    uploadMapTexture() {
      if (!this.stagingCanvas.width || !this.stagingCanvas.height) return false;
      try {
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.stagingCanvas);
        return true;
      } catch (_) {
        return false;
      }
    }

    fallbackCameraBasis() {
      const heading = Number(this.pose.heading || 0) * DEG;
      const elevation = -Number(this.pose.pitch || 0) * DEG;
      const forward = {
        x: Math.sin(heading) * Math.cos(elevation),
        y: Math.sin(elevation),
        z: Math.cos(heading) * Math.cos(elevation)
      };
      const right = { x: Math.cos(heading), y: 0, z: -Math.sin(heading) };
      let up = {
        x: right.y * forward.z - right.z * forward.y,
        y: right.z * forward.x - right.x * forward.z,
        z: right.x * forward.y - right.y * forward.x
      };
      const roll = Number(this.pose.roll || 0) * DEG;
      if (roll) {
        const cos = Math.cos(roll);
        const sin = Math.sin(roll);
        const rolledRight = {
          x: right.x * cos - up.x * sin,
          y: right.y * cos - up.y * sin,
          z: right.z * cos - up.z * sin
        };
        up = {
          x: right.x * sin + up.x * cos,
          y: right.y * sin + up.y * cos,
          z: right.z * sin + up.z * cos
        };
        return { right: rolledRight, up, forward };
      }
      return { right, up, forward };
    }

    applyCamera() {
      const cameraPosition = this.cameraPosition();
      if (!cameraPosition) return false;
      const basis = this.pose.orientation && this.pose.orientation.hasMatrix
        ? this.pose.orientation.cameraBasis()
        : this.fallbackCameraBasis();
      const gl = this.gl;
      gl.uniform3f(this.uniforms.cameraPosition, cameraPosition.x, cameraPosition.y, cameraPosition.z);
      gl.uniform3f(this.uniforms.cameraRight, basis.right.x, basis.right.y, basis.right.z);
      gl.uniform3f(this.uniforms.cameraUp, basis.up.x, basis.up.y, basis.up.z);
      gl.uniform3f(this.uniforms.cameraForward, basis.forward.x, basis.forward.y, basis.forward.z);
      return true;
    }

    render() {
      if (!this.active || !this.gl || !this.program) return;
      if (typeof this.radar.syncReferenceOverlay === 'function') this.radar.syncReferenceOverlay();
      this.resize();
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      if (!this.rebuildMapTexture()) return;
      const now = performance.now();
      if (this.meshDirty || !this.indexCount || now - this.lastTerrainRefresh > 2000) {
        if (now - this.lastMeshAttempt > 250) {
          this.lastMeshAttempt = now;
          this.rebuildGroundMesh();
        }
      }
      if (!this.indexCount) return;

      gl.useProgram(this.program);
      if (!this.applyCamera()) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (!this.uploadMapTexture()) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();
