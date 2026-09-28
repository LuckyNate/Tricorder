(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

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
      this.rangeMeters = radar ? radar.rangeMeters : 20;
      this.pose = {
        heading: 0,
        pitch: 0,
        roll: 0,
        altitude: null,
        verticalAccuracy: null
      };
      this.viewVersion = 0;
      this.targetLayer = null;
      this.horizon = null;
      this.headingLabel = null;
      this.pitchLabel = null;
      this.rangeLabel = null;
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

      this.scene.append(grid, horizon, targets, reticle, headingReadout, pitchReadout, rangeReadout);
    }

    setPose(pose = {}) {
      if (Number.isFinite(Number(pose.heading))) this.pose.heading = wrapDegrees(Number(pose.heading));
      if (Number.isFinite(Number(pose.pitch))) this.pose.pitch = Number(pose.pitch);
      if (Number.isFinite(Number(pose.roll))) this.pose.roll = Number(pose.roll);
      if (Number.isFinite(Number(pose.altitude))) this.pose.altitude = Number(pose.altitude);
      if (Number.isFinite(Number(pose.verticalAccuracy))) this.pose.verticalAccuracy = Number(pose.verticalAccuracy);
      this.viewVersion += 1;
    }

    setRange(meters) {
      const next = Number(meters) || 20;
      if (next === this.rangeMeters) return;
      this.rangeMeters = next;
      this.viewVersion += 1;
    }

    cameraElevationDegrees() {
      // Android SensorManager pitch is opposite the rear-camera look elevation.
      return -Number(this.pose.pitch || 0);
    }

    estimateVertical(target, observer, horizontalDistance) {
      if (target.position && Number.isFinite(Number(target.position.altitude))) {
        return {
          altitude: Number(target.position.altitude),
          uncertainty: Math.max(3, Number(target.uncertaintyMeters) || 5),
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
        Number(target.uncertaintyMeters) || 5,
        Math.abs(Math.tan(Math.min(45, elevationSigma + 8) * DEG) * Math.max(1, horizontalDistance)),
        Number(this.pose.verticalAccuracy) || 0
      );

      return {
        altitude: observer.altitude + clamp(verticalOffset, -this.rangeMeters, this.rangeMeters),
        uncertainty: clamp(verticalUncertainty, 4, this.rangeMeters),
        confidence: clamp(samples.length / 16, 0, 0.65)
      };
    }

    spatialTarget(target) {
      const observer = observerFromRadar(this.radar, this.pose);
      const position = target && target.position;
      if (!observer || !position) return null;

      const horizontal = horizontalOffsetMeters(observer, position);
      const horizontalDistance = Math.hypot(horizontal.east, horizontal.north);
      const vertical = this.estimateVertical(target, observer, horizontalDistance);
      const up = Number.isFinite(vertical.altitude) && Number.isFinite(observer.altitude)
        ? vertical.altitude - observer.altitude
        : 0;
      const distance = Math.hypot(horizontalDistance, up);
      const bearing = wrapDegrees(Math.atan2(horizontal.east, horizontal.north) / DEG);
      const elevation = Math.atan2(up, Math.max(0.001, horizontalDistance)) / DEG;
      const uncertainty = Math.max(Number(target.uncertaintyMeters) || 5, vertical.uncertainty || 0);

      target.spatial = {
        altitude: vertical.altitude,
        verticalUncertaintyMeters: vertical.uncertainty,
        uncertaintyMeters: uncertainty,
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
        uncertainty
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

      // Inverse camera roll: the world rotates opposite the handset.
      const roll = Number(this.pose.roll || 0) * DEG;
      const cos = Math.cos(roll);
      const sin = Math.sin(roll);
      const rolledX = x * cos - y * sin;
      const rolledY = x * sin + y * cos;
      x = rolledX;
      y = rolledY;

      return { x, y, z, yaw, pitch };
    }

    project(relative) {
      if (!this.scene) return null;
      const camera = this.cameraRelative(relative);
      if (!camera || camera.z <= 0.05) return null;

      const width = this.scene.clientWidth || 320;
      const height = this.scene.clientHeight || 320;
      const verticalFov = 68 * DEG;
      const focal = (height * 0.5) / Math.tan(verticalFov * 0.5);

      return {
        x: width * 0.5 + (camera.x / camera.z) * focal,
        y: height * 0.5 - (camera.y / camera.z) * focal,
        depth: camera.z,
        focal,
        width,
        height
      };
    }

    renderHorizon() {
      if (!this.horizon || !this.scene) return;
      const height = this.scene.clientHeight || 320;
      const verticalFov = 68 * DEG;
      const focal = (height * 0.5) / Math.tan(verticalFov * 0.5);
      const elevation = this.cameraElevationDegrees();
      const offset = Math.tan(elevation * DEG) * focal;
      this.horizon.style.transform = `translateY(${offset}px) rotate(${Number(this.pose.roll || 0)}deg)`;
    }

    render(engine) {
      if (!this.root || this.root.hidden || !this.scene || !this.targetLayer) return;
      this.rangeMeters = this.radar ? this.radar.rangeMeters : this.rangeMeters;

      if (this.headingLabel) this.headingLabel.textContent = `${Math.round(wrapDegrees(this.pose.heading || 0))}°`;
      if (this.pitchLabel) {
        const elevation = this.cameraElevationDegrees();
        this.pitchLabel.textContent = `${elevation >= 0 ? '+' : ''}${Math.round(elevation)}°`;
      }
      if (this.rangeLabel) this.rangeLabel.textContent = `${Math.round(this.rangeMeters)} m`;
      this.renderHorizon();

      this.targetLayer.replaceChildren();

      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;

          const spatial = this.spatialTarget(target);
          if (!spatial) return;
          if (spatial.distance - spatial.uncertainty > this.rangeMeters) return;

          const projected = this.project(spatial);
          if (!projected) return;

          const radiusPx = clamp(
            Math.atan2(spatial.uncertainty, Math.max(0.5, projected.depth)) * projected.focal,
            7,
            Math.min(projected.width, projected.height) * 0.46
          );

          if (
            projected.x < -radiusPx || projected.x > projected.width + radiusPx ||
            projected.y < -radiusPx || projected.y > projected.height + radiusPx
          ) return;

          const sphere = document.createElement('div');
          sphere.className = 'spatial-target-sphere';
          sphere.style.setProperty('--sensor-color', sensor.color);
          sphere.style.width = `${radiusPx * 2}px`;
          sphere.style.height = `${radiusPx * 2}px`;
          sphere.style.left = `${projected.x - radiusPx}px`;
          sphere.style.top = `${projected.y - radiusPx}px`;
          sphere.style.opacity = String(clamp(0.18 + (target.confidence || 0) * 0.62, 0.18, 0.82));
          sphere.style.zIndex = String(Math.max(1, Math.round(10000 - projected.depth * 10)));
          sphere.title = `${target.name || target.id} · ${Math.round(spatial.distance)}m · uncertainty ±${Math.round(spatial.uncertainty)}m`;
          this.targetLayer.appendChild(sphere);

          if ((target.confidence || 0) >= 0.62) {
            const dot = document.createElement('div');
            dot.className = 'spatial-target-dot';
            dot.style.setProperty('--sensor-color', sensor.color);
            dot.style.left = `${projected.x - 4}px`;
            dot.style.top = `${projected.y - 4}px`;
            dot.style.zIndex = String(Math.max(2, Math.round(10001 - projected.depth * 10)));
            this.targetLayer.appendChild(dot);
          }
        });
      });
    }
  }

  window.SpatialView = SpatialView;
})();
