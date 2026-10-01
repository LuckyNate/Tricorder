(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

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

      void main() {
        gl_FragColor = texture2D(uMap, vUv);
      }
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
      this.gridCells = 24;
      this.terrainSamples = new Map();
      this.maxTerrainSamples = 256;
      this.arOrigin = null;
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
      return this.radar && this.radar.referenceOverlayMap
        ? this.radar.referenceOverlayMap
        : null;
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
      if (this.active) this.ensureArOrigin();
      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
      if (this.active) this.ensureArOrigin();
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    setGravityVector() {}

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
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
      if (this.terrainSamples.has(key)) this.terrainSamples.delete(key);
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
        .map(sample => ({
          sample,
          distance: this.terrainDistanceMeters(lat, lng, sample.latitude, sample.longitude)
        }))
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

    rebuildGroundMesh() {
      const map = this.referenceMap();
      const source = this.sourceCanvas();
      if (!map || !source || !source.width || !source.height) return false;
      if (!this.ensureArOrigin()) return false;

      const displayWidth = Math.max(1, source.clientWidth || (map.getContainer && map.getContainer().clientWidth) || source.width);
      const displayHeight = Math.max(1, source.clientHeight || (map.getContainer && map.getContainer().clientHeight) || source.height);
      const cells = this.gridCells;
      const columns = cells + 1;
      const points = new Array(columns * columns);

      for (let row = 0; row <= cells; row += 1) {
        const py = displayHeight * row / cells;
        const v = row / cells;
        for (let col = 0; col <= cells; col += 1) {
          const px = displayWidth * col / cells;
          const u = col / cells;
          const index = row * columns + col;
          let lngLat = null;
          try {
            lngLat = map.unproject([px, py]);
          } catch (_) {}

          let elevation = null;
          if (lngLat) {
            elevation = this.terrainElevation(map, lngLat);
            if (finite(elevation)) this.rememberTerrainSample(lngLat.lat, lngLat.lng, elevation);
          }
          points[index] = { lngLat, elevation, u, v };
        }
      }

      if (!this.terrainSamples.size) return false;

      const vertices = [];
      const valid = new Uint8Array(columns * columns);

      points.forEach((point, index) => {
        let world = null;
        if (point.lngLat) {
          const elevation = finite(point.elevation)
            ? Number(point.elevation)
            : this.estimateTerrainElevation(point.lngLat.lat, point.lngLat.lng);
          if (finite(elevation)) {
            world = this.worldPosition(point.lngLat.lat, point.lngLat.lng, elevation);
          }
        }

        if (world && finite(world.x) && finite(world.y) && finite(world.z)) {
          vertices.push(world.x, world.y, world.z, point.u, point.v);
          valid[index] = 1;
        } else {
          vertices.push(0, 0, 0, point.u, point.v);
        }
      });

      const indices = [];
      for (let row = 0; row < cells; row += 1) {
        for (let col = 0; col < cells; col += 1) {
          const a = row * columns + col;
          const b = a + 1;
          const c = a + columns;
          const d = c + 1;
          if (valid[a] && valid[b] && valid[c]) indices.push(a, b, c);
          if (valid[c] && valid[b] && valid[d]) indices.push(c, b, d);
        }
      }

      if (!indices.length) return false;

      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.DYNAMIC_DRAW);
      this.indexCount = indices.length;
      return true;
    }

    uploadMapTexture(source) {
      if (!this.stagingContext || !source || !source.width || !source.height) return false;
      if (this.stagingCanvas.width !== source.width || this.stagingCanvas.height !== source.height) {
        this.stagingCanvas.width = source.width;
        this.stagingCanvas.height = source.height;
      }
      try {
        this.stagingContext.clearRect(0, 0, this.stagingCanvas.width, this.stagingCanvas.height);
        this.stagingContext.drawImage(source, 0, 0, this.stagingCanvas.width, this.stagingCanvas.height);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, false);
        this.gl.texImage2D(
          this.gl.TEXTURE_2D,
          0,
          this.gl.RGBA,
          this.gl.RGBA,
          this.gl.UNSIGNED_BYTE,
          this.stagingCanvas
        );
        return true;
      } catch (_) {
        return false;
      }
    }

    applyCamera() {
      const cameraPosition = this.cameraPosition();
      if (!cameraPosition) return false;
      const basis = this.pose.orientation.cameraBasis();
      const gl = this.gl;
      gl.uniform3f(this.uniforms.cameraPosition, cameraPosition.x, cameraPosition.y, cameraPosition.z);
      gl.uniform3f(this.uniforms.cameraRight, basis.right.x, basis.right.y, basis.right.z);
      gl.uniform3f(this.uniforms.cameraUp, basis.up.x, basis.up.y, basis.up.z);
      gl.uniform3f(this.uniforms.cameraForward, basis.forward.x, basis.forward.y, basis.forward.z);
      return true;
    }

    render() {
      if (!this.active || !this.gl || !this.program) return;
      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }

      this.resize();
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      const source = this.sourceCanvas();
      if (!source || !source.width || !source.height) return;
      if (!this.rebuildGroundMesh()) return;

      gl.useProgram(this.program);
      if (!this.applyCamera()) return;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      if (!this.uploadMapTexture(source)) return;

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();
