(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;
  const FRAME_INTERVAL_MS = 1000 / 30;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function angleDelta(a, b) {
    return ((a - b + 540) % 360) - 180;
  }

  function metersPerDegreeLng(latitude) {
    return METERS_PER_DEGREE_LAT * Math.cos(latitude * DEG);
  }

  function observerFromRadar(radar, pose) {
    const location = radar && radar.location;
    if (!location) return null;
    return {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      altitude: Number.isFinite(Number(location.altitude))
        ? Number(location.altitude)
        : (Number.isFinite(Number(pose.altitude)) ? Number(pose.altitude) : null)
    };
  }

  function horizontalOffsetMeters(origin, position) {
    const meanLat = (origin.latitude + position.latitude) * 0.5;
    return {
      east: (position.longitude - origin.longitude) * metersPerDegreeLng(meanLat),
      north: (position.latitude - origin.latitude) * METERS_PER_DEGREE_LAT
    };
  }

  class SpatialView {
    constructor(radar) {
      this.radar = radar;
      this.root = document.getElementById('threeDView');
      this.scene = document.getElementById('spatialScene');
      this.camera = document.getElementById('spatialCamera');
      this.rangeMeters = radar ? radar.rangeMeters : 20;
      this.pose = {
        heading: 0,
        pitch: 0,
        roll: 0,
        altitude: null,
        verticalAccuracy: null
      };
      this.active = false;
      this.cameraStream = null;
      this.cameraStarting = false;
      this.cameraHorizontalFov = 70;
      this.lastRenderAt = 0;
      this.targetLayer = null;
      this.horizon = null;
      this.headingLabel = null;
      this.pitchLabel = null;
      this.rangeLabel = null;
      this.cameraLabel = null;
      this.nodes = new Map();
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();

      const grid = document.createElement('div');
      grid.className = 'spatial-grid';
      grid.setAttribute('aria-hidden', 'true');

      const horizon = document.createElement('div');
      horizon.className = 'spatial-horizon';
      horizon.setAttribute('aria-hidden', 'true');
      this.horizon = horizon;

      const targets = document.createElement('div');
      targets.id = 'spatialTargets';
      this.targetLayer = targets;

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

      this.scene.append(grid, horizon, targets, reticle, headingReadout, pitchReadout, rangeReadout, cameraReadout);
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
      } catch (error) {
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

    setPose(pose = {}) {
      if (Number.isFinite(Number(pose.heading))) this.pose.heading = wrapDegrees(Number(pose.heading));
      if (Number.isFinite(Number(pose.pitch))) this.pose.pitch = Number(pose.pitch);
      if (Number.isFinite(Number(pose.roll))) this.pose.roll = Number(pose.roll);
      if (Number.isFinite(Number(pose.altitude))) this.pose.altitude = Number(pose.altitude);
      if (Number.isFinite(Number(pose.verticalAccuracy))) this.pose.verticalAccuracy = Number(pose.verticalAccuracy);
    }

    setRange(meters) {
      this.rangeMeters = Number(meters) || 20;
    }

    cameraElevationDegrees() {
      return -Number(this.pose.pitch || 0);
    }

    effectiveProjection() {
      const width = this.scene ? (this.scene.clientWidth || 320) : 320;
      const height = this.scene ? (this.scene.clientHeight || 320) : 320;
      const videoWidth = this.camera && this.camera.videoWidth ? this.camera.videoWidth : width;
      const videoHeight = this.camera && this.camera.videoHeight ? this.camera.videoHeight : height;
      const videoAspect = Math.max(0.25, videoWidth / Math.max(1, videoHeight));
      const viewportAspect = Math.max(0.25, width / Math.max(1, height));
      let horizontalFov = this.cameraHorizontalFov * DEG;
      let verticalFov = 2 * Math.atan(Math.tan(horizontalFov * 0.5) / videoAspect);

      if (viewportAspect > videoAspect) {
        verticalFov = 2 * Math.atan(Math.tan(verticalFov * 0.5) * (videoAspect / viewportAspect));
      } else if (viewportAspect < videoAspect) {
        horizontalFov = 2 * Math.atan(Math.tan(horizontalFov * 0.5) * (viewportAspect / videoAspect));
      }

      const focalX = (width * 0.5) / Math.tan(horizontalFov * 0.5);
      const focalY = (height * 0.5) / Math.tan(verticalFov * 0.5);
      return { width, height, focalX, focalY };
    }

    estimateVerticalCandidate(target, observer, horizontalDistance) {
      if (target.position && Number.isFinite(Number(target.position.altitude))) {
        return {
          altitude: Number(target.position.altitude),
          uncertainty: Math.max(2, Number(target.uncertaintyMeters) || 5),
          confidence: Number(target.confidence) || 0
        };
      }

      const samples = (target.observations || []).filter(observation => {
        const raw = observation.raw || {};
        return Number.isFinite(Number(raw.pitch)) && Number.isFinite(Number(observation.rssi));
      });

      if (!samples.length || !Number.isFinite(observer.altitude)) {
        return {
          altitude: observer.altitude,
          uncertainty: Math.max(Number(target.uncertaintyMeters) || 5, this.rangeMeters * 0.55),
          confidence: 0
        };
      }

      const meanRssi = samples.reduce((sum, observation) => sum + Number(observation.rssi), 0) / samples.length;
      let weightedElevation = 0;
      let weightTotal = 0;
      let elevationMean = 0;
      let elevationSq = 0;

      samples.forEach(observation => {
        const raw = observation.raw || {};
        const elevation = -Number(raw.pitch);
        const rssi = Number(observation.rssi);
        const signalBias = clamp((rssi - meanRssi + 8) / 16, 0.08, 1);
        const accuracy = Math.max(4, Number(observation.accuracy) || 25);
        const weight = signalBias / accuracy;
        weightedElevation += elevation * weight;
        weightTotal += weight;
      });

      if (!weightTotal) {
        return {
          altitude: observer.altitude,
          uncertainty: Math.max(Number(target.uncertaintyMeters) || 5, this.rangeMeters * 0.55),
          confidence: 0
        };
      }

      const elevation = clamp(weightedElevation / weightTotal, -75, 75);
      samples.forEach(observation => {
        const sampleElevation = -Number((observation.raw || {}).pitch);
        elevationMean += sampleElevation;
        elevationSq += sampleElevation * sampleElevation;
      });
      elevationMean /= samples.length;
      const elevationVariance = Math.max(0, elevationSq / samples.length - elevationMean * elevationMean);
      const elevationSigma = Math.sqrt(elevationVariance);
      const verticalOffset = Math.tan(elevation * DEG) * Math.max(0.5, horizontalDistance);
      const verticalUncertainty = Math.max(
        3,
        Math.abs(Math.tan(Math.min(45, elevationSigma + 8) * DEG) * Math.max(1, horizontalDistance)),
        Number(this.pose.verticalAccuracy) || 0
      );

      return {
        altitude: observer.altitude + clamp(verticalOffset, -this.rangeMeters, this.rangeMeters),
        uncertainty: clamp(verticalUncertainty, 3, this.rangeMeters),
        confidence: clamp(samples.length / 16, 0, 0.65)
      };
    }

    bestVertical(target, candidate) {
      const previous = target.spatialVertical;
      if (!previous) {
        target.spatialVertical = candidate;
        return candidate;
      }
      const uncertaintyNoWorse = candidate.uncertainty <= previous.uncertainty + 0.05;
      const confidenceNoWorse = candidate.confidence + 0.005 >= previous.confidence;
      const strictlyBetter = candidate.uncertainty < previous.uncertainty - 0.05 || candidate.confidence > previous.confidence + 0.005;
      if (uncertaintyNoWorse && confidenceNoWorse && strictlyBetter) target.spatialVertical = candidate;
      return target.spatialVertical;
    }

    spatialTarget(target) {
      const observer = observerFromRadar(this.radar, this.pose);
      const position = target && target.position;
      if (!observer || !position) return null;

      const horizontal = horizontalOffsetMeters(observer, position);
      const horizontalDistance = Math.hypot(horizontal.east, horizontal.north);
      const vertical = this.bestVertical(target, this.estimateVerticalCandidate(target, observer, horizontalDistance));
      const up = Number.isFinite(vertical.altitude) && Number.isFinite(observer.altitude)
        ? vertical.altitude - observer.altitude
        : 0;
      const distance = Math.hypot(horizontalDistance, up);
      const bearing = wrapDegrees(Math.atan2(horizontal.east, horizontal.north) / DEG);
      const elevation = Math.atan2(up, Math.max(0.001, horizontalDistance)) / DEG;

      target.spatial = {
        altitude: vertical.altitude,
        verticalUncertaintyMeters: vertical.uncertainty,
        horizontalUncertaintyMeters: Number(target.uncertaintyMeters) || 5,
        confidence: Math.max(Number(target.confidence) || 0, vertical.confidence || 0)
      };

      return {
        east: horizontal.east,
        north: horizontal.north,
        up,
        horizontalDistance,
        distance,
        bearing,
        elevation,
        horizontalUncertainty: Math.max(1, Number(target.uncertaintyMeters) || 5),
        verticalUncertainty: Math.max(1, vertical.uncertainty || Number(target.uncertaintyMeters) || 5)
      };
    }

    cameraRelative(relative) {
      const yaw = angleDelta(relative.bearing, Number(this.pose.heading || 0));
      const pitch = relative.elevation - this.cameraElevationDegrees();
      const distance = Math.max(0.001, relative.distance);
      const yawRad = yaw * DEG;
      const pitchRad = pitch * DEG;

      let x = distance * Math.cos(pitchRad) * Math.sin(yawRad);
      let y = distance * Math.sin(pitchRad);
      const z = distance * Math.cos(pitchRad) * Math.cos(yawRad);

      const roll = Number(this.pose.roll || 0) * DEG;
      const cos = Math.cos(roll);
      const sin = Math.sin(roll);
      const rolledX = x * cos - y * sin;
      const rolledY = x * sin + y * cos;
      x = rolledX;
      y = rolledY;

      return { x, y, z };
    }

    project(relative) {
      const camera = this.cameraRelative(relative);
      if (!camera || camera.z <= 0.05) return null;
      const projection = this.effectiveProjection();
      return {
        x: projection.width * 0.5 + (camera.x / camera.z) * projection.focalX,
        y: projection.height * 0.5 - (camera.y / camera.z) * projection.focalY,
        depth: camera.z,
        width: projection.width,
        height: projection.height,
        focalX: projection.focalX,
        focalY: projection.focalY
      };
    }

    renderHorizon() {
      if (!this.horizon || !this.scene) return;
      const projection = this.effectiveProjection();
      const elevation = this.cameraElevationDegrees();
      const offset = Math.tan(elevation * DEG) * projection.focalY;
      this.horizon.style.transform = `translate3d(0,${offset}px,0) rotate(${Number(this.pose.roll || 0)}deg)`;
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

    render(engine, now = performance.now()) {
      if (!this.active || !this.root || this.root.hidden || !this.scene || !this.targetLayer) return;
      if (now - this.lastRenderAt < FRAME_INTERVAL_MS) return;
      this.lastRenderAt = now;
      this.rangeMeters = this.radar ? this.radar.rangeMeters : this.rangeMeters;

      if (this.headingLabel) this.headingLabel.textContent = `${Math.round(wrapDegrees(this.pose.heading || 0))}°`;
      if (this.pitchLabel) {
        const elevation = this.cameraElevationDegrees();
        this.pitchLabel.textContent = `${elevation >= 0 ? '+' : ''}${Math.round(elevation)}°`;
      }
      if (this.rangeLabel) this.rangeLabel.textContent = `${Math.round(this.rangeMeters)} m`;
      this.renderHorizon();

      this.nodes.forEach(node => { node.seen = false; });

      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;
          const spatial = this.spatialTarget(target);
          if (!spatial) return;
          if (spatial.distance - Math.max(spatial.horizontalUncertainty, spatial.verticalUncertainty) > this.rangeMeters) return;
          const projected = this.project(spatial);
          if (!projected) return;

          const radiusX = clamp(
            Math.atan2(spatial.horizontalUncertainty, Math.max(0.5, projected.depth)) * projected.focalX,
            8,
            projected.width * 0.48
          );
          const radiusY = clamp(
            Math.atan2(spatial.verticalUncertainty, Math.max(0.5, projected.depth)) * projected.focalY,
            8,
            projected.height * 0.48
          );
          if (
            projected.x < -radiusX || projected.x > projected.width + radiusX ||
            projected.y < -radiusY || projected.y > projected.height + radiusY
          ) return;

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
          node.cloud.title = `${target.name || target.id} · ${Math.round(spatial.distance)}m · uncertainty ${Math.round(spatial.horizontalUncertainty)}m × ${Math.round(spatial.verticalUncertainty)}m`;
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
  }

  window.SpatialView = SpatialView;
})();
