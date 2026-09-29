(() => {
  if (!window.ScannerCore || !window.SpatialView || !window.WorldSpace) {
    throw new Error('Unified spatial adapters loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const BaseSpatialView = window.SpatialView;
  const { WorldSpaceModel, clamp, wrapDegrees } = window.WorldSpace;

  class UnifiedRadarView extends BaseRadarView {
    constructor(world = new WorldSpaceModel()) {
      super();
      this.world = world;
      this.world.setRange(this.rangeMeters);
      if (this.targetLayer) this.targetLayer.style.opacity = '0.42';
    }

    setLocation(latitude, longitude, accuracy) {
      super.setLocation(latitude, longitude, accuracy);
      this.world.setLocation(latitude, longitude, accuracy,
        this.location && this.location.altitude,
        this.location && this.location.verticalAccuracy);
    }

    setHeading(degrees) {
      if (!Number.isFinite(Number(degrees))) return;
      this.heading = wrapDegrees(Number(degrees));
      this.world.setHeading(this.heading);
      if (this.rotatorEl) {
        this.rotatorEl.style.transform = `rotate(${this.world.mapRotationDegrees()}deg) scale(1.18)`;
      }
    }

    setRange(meters) {
      this.world.setRange(meters);
      super.setRange(meters);
    }

    projectTarget(target) {
      if (!this.location || !target || !this.mapEl) return null;
      const width = this.mapEl.clientWidth || 320;
      const height = this.mapEl.clientHeight || 320;
      return this.world.projectTopDown(target, this.metersPerPixel(), width, height);
    }

    render(engine) {
      if (!this.targetLayer) return;
      this.targetLayer.replaceChildren();
      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;
          const point = this.projectTarget(target);
          if (!point) return;
          const radiusPx = Math.max(5, Math.min(140, (target.uncertaintyMeters || 5) / this.metersPerPixel()));
          const confidence = Math.max(0, Math.min(1, Number(target.confidence) || 0));
          const stackOrder = 1 + Math.round(confidence * 1000);
          const cloud = document.createElement('div');
          cloud.className = 'target-cloud';
          cloud.style.setProperty('--sensor-color', sensor.color);
          cloud.style.width = `${radiusPx * 2}px`;
          cloud.style.height = `${radiusPx * 2}px`;
          cloud.style.left = `${point.x - radiusPx}px`;
          cloud.style.top = `${point.y - radiusPx}px`;
          cloud.style.opacity = '1';
          cloud.style.zIndex = String(stackOrder);
          cloud.style.background = 'var(--sensor-color)';
          cloud.style.boxShadow = 'none';
          if (target.rangeRegion) {
            const inner = Math.max(0, Math.min(95, target.rangeRegion.innerMeters / target.rangeRegion.outerMeters * 100));
            cloud.style.background = `radial-gradient(circle, transparent ${inner}%, var(--sensor-color) ${Math.min(100, inner + 2)}%)`;
          }
          this.targetLayer.appendChild(cloud);

          if (target.confidence >= 0.62) {
            const dot = document.createElement('div');
            dot.className = 'target-dot';
            dot.style.setProperty('--sensor-color', sensor.color);
            dot.style.left = `${point.x - 4}px`;
            dot.style.top = `${point.y - 4}px`;
            dot.style.zIndex = String(stackOrder + 1);
            this.targetLayer.appendChild(dot);
          }
        });
      });
    }

    ping(target) {
      if (!target || !target.position || !this.pingLayer) return false;
      const point = this.projectTarget(target);
      if (!point) return false;

      const ripple = document.createElement('div');
      ripple.className = 'target-ripple';
      ripple.style.setProperty('--sensor-color', target.sensor.color);
      ripple.style.left = `${point.x}px`;
      ripple.style.top = `${point.y}px`;

      for (let index = 0; index < 3; index += 1) {
        const ring = document.createElement('span');
        ring.className = 'target-ripple-ring';
        ring.style.animationDelay = `${index * 300}ms`;
        ripple.appendChild(ring);
      }

      this.pingLayer.appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 3000);
      return true;
    }
  }

  class UnifiedSpatialView extends BaseSpatialView {
    constructor(radar) {
      super(radar);
      if (!radar || !radar.world) throw new Error('SpatialView requires shared world model');
      this.world = radar.world;
      this.pose = this.world.pose;
    }

    setPose(pose = {}) {
      this.world.setPose(pose);
      this.pose = this.world.pose;
    }

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
    }

    cameraElevationDegrees() {
      return this.world.camera.cameraElevationDegrees(this.world.pose);
    }

    spatialTarget(target) {
      return this.world.resolveTarget(target);
    }

    cameraRelative(relative) {
      return this.world.camera.relative(relative, this.world.pose);
    }

    project(relative) {
      return this.world.camera.project(relative, this.world.pose, this.effectiveProjection());
    }

    renderHorizon() {
      if (!this.horizon || !this.scene) return;
      const projection = this.effectiveProjection();
      const elevation = this.cameraElevationDegrees();
      const offset = Math.tan(elevation * Math.PI / 180) * projection.focalY;
      const roll = this.world.camera.cameraRollDegrees(this.world.pose);
      this.horizon.style.transform = `translate3d(0,${offset}px,0) rotate(${roll}deg)`;
    }

    render(engine, now = performance.now()) {
      if (!this.active || !this.root || this.root.hidden || !this.scene || !this.targetLayer) return;
      if (now - this.lastRenderAt < 1000 / 30) return;
      this.lastRenderAt = now;
      this.rangeMeters = this.world.rangeMeters;

      if (this.headingLabel) this.headingLabel.textContent = `${Math.round(this.world.mapHeadingDegrees())}°`;
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
          const vector = this.world.resolveTarget(target);
          if (!vector) return;
          if (vector.distance - Math.max(vector.horizontalUncertainty, vector.verticalUncertainty) > this.rangeMeters) return;
          const projected = this.world.camera.project(vector, this.world.pose, this.effectiveProjection());
          if (!projected) return;

          const radiusX = clamp(
            Math.atan2(vector.horizontalUncertainty, Math.max(0.5, projected.depth)) * projected.focalX,
            8,
            projected.width * 0.48
          );
          const radiusY = clamp(
            Math.atan2(vector.verticalUncertainty, Math.max(0.5, projected.depth)) * projected.focalY,
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
          node.cloud.title = `${target.name || target.id} · ${Math.round(vector.distance)}m · uncertainty ${Math.round(vector.horizontalUncertainty)}m × ${Math.round(vector.verticalUncertainty)}m`;
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

  window.ScannerCore.RadarView = UnifiedRadarView;
  window.SpatialView = UnifiedSpatialView;
})();