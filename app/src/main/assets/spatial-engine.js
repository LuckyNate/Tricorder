(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;

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
      attribute vec3 aPosition;
      attribute vec2 aUv;
      uniform float uAspect;
      uniform float uFar;
      varying vec2 vUv;

      void main() {
        float f = 1.7320508;
        float nearPlane = 0.05;
        float farPlane = max(uFar, nearPlane + 1.0);
        float z = aPosition.z;

        gl_Position = vec4(
          aPosition.x * f / uAspect,
          aPosition.y * f,
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
      this.aspectLocation = null;
      this.farLocation = null;
      this.vertexBuffer = null;
      this.indexBuffer = null;
      this.indexCount = 0;
      this.gridCells = 24;
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
      const positionLocation = gl.getAttribLocation(this.program, 'aPosition');
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

      gl.useProgram(this.program);
      gl.uniform1i(gl.getUniformLocation(this.program, 'uMap'), 0);
      this.aspectLocation = gl.getUniformLocation(this.program, 'uAspect');
      this.farLocation = gl.getUniformLocation(this.program, 'uFar');
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
      if (this.aspectLocation) this.gl.uniform1f(this.aspectLocation, width / height);
      if (this.farLocation) this.gl.uniform1f(this.farLocation, Math.max(100, this.rangeMeters * 3));
    }

    setActive(active) {
      this.active = Boolean(active);
      if (this.root) this.root.dataset.mapFirst = this.active ? 'true' : 'false';
      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
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

    rebuildGroundMesh() {
      const map = this.referenceMap();
      const source = this.sourceCanvas();
      if (!map || !source || !source.width || !source.height) return false;
      if (!this.pose.hasLocation() || !this.pose.hasAltitude()) return false;

      const displayWidth = Math.max(1, source.clientWidth || (map.getContainer && map.getContainer().clientWidth) || source.width);
      const displayHeight = Math.max(1, source.clientHeight || (map.getContainer && map.getContainer().clientHeight) || source.height);
      const cells = this.gridCells;
      const columns = cells + 1;
      const vertices = [];
      const valid = new Uint8Array(columns * columns);

      for (let row = 0; row <= cells; row += 1) {
        const py = displayHeight * row / cells;
        const v = row / cells;
        for (let col = 0; col <= cells; col += 1) {
          const px = displayWidth * col / cells;
          const u = col / cells;
          let lngLat;
          try {
            lngLat = map.unproject([px, py]);
          } catch (_) {
            lngLat = null;
          }

          const elevation = lngLat ? this.terrainElevation(map, lngLat) : null;
          let camera = null;
          if (lngLat && finite(elevation)) {
            const vector = this.world.geographicVector({
              latitude: lngLat.lat,
              longitude: lngLat.lng,
              altitude: elevation
            });
            if (vector) camera = this.world.camera.relative(vector, this.pose);
          }

          const index = row * columns + col;
          if (camera && finite(camera.x) && finite(camera.y) && finite(camera.z)) {
            vertices.push(camera.x, camera.y, camera.z, u, v);
            valid[index] = 1;
          } else {
            vertices.push(0, 0, -1, u, v);
          }
        }
      }

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
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);

      try {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      } catch (_) {
        return;
      }

      gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();