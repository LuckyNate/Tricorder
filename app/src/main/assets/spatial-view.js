(() => {
  const METERS_PER_DEGREE_LAT = 111320;

  function metersPerDegreeLng(latitude) {
    return METERS_PER_DEGREE_LAT * Math.cos(latitude * Math.PI / 180);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function angularDifferenceDegrees(a, b) {
    return ((a - b + 540) % 360) - 180;
  }

  class SpatialView {
    constructor(radar) {
      this.radar = radar;
      this.root = document.getElementById('threeDView');
      this.scene = document.getElementById('spatialScene');
      this.targetLayer = document.getElementById('spatialTargets');
      this.headingLabel = document.getElementById('spatialHeading');
      this.pitchLabel = document.getElementById('spatialPitch');
      this.rangeLabel = document.getElementById('spatialRange');
      this.pose = { heading: 0, pitch: 0, roll: 0, altitude: null, verticalAccuracy: null };
      this.rangeMeters = radar ? radar.rangeMeters : 20;
      this.viewVersion = 0;
    }

    setPose(pose = {}) {
      const nextHeading = Number.isFinite(Number(pose.heading)) ? wrapDegrees(Number(pose.heading)) : this.pose.heading;
      const nextPitch = Number.isFinite(Number(pose.pitch)) ? Number(pose.pitch) : this.pose.pitch;
      const nextRoll = Number.isFinite(Number(pose.roll)) ? Number(pose.roll) : this.pose.roll;
      const nextAltitude = Number.isFinite(Number(pose.altitude)) ? Number(pose.altitude) : this.pose.altitude;
      const nextVerticalAccuracy = Number.isFinite(Number(pose.verticalAccuracy)) ? Number(pose.verticalAccuracy) : this.pose.verticalAccuracy;
      this.pose = { heading: nextHeading, pitch: nextPitch, roll: nextRoll, altitude: nextAltitude, verticalAccuracy: nextVerticalAccuracy };
      this.viewVersion += 1;
    }

    setRange(meters) {
      const next = Number(meters) || 20;
      if (next === this.rangeMeters) return;
      this.rangeMeters = next;
      this.viewVersion += 1;
    }

    observerPosition() {
      const location = this.radar && this.radar.location;
      if (!location) return null;
      return {
        latitude: location.latitude,
        longitude: location.longitude,
        altitude: Number.isFinite(Number(location.altitude)) ? Number(location.altitude) : this.pose.altitude
      };
    }

    resolveTargetAltitude(target) {
      if (!target || !target.position) return null;
      if (Number.isFinite(Number(target.position.altitude))) return Number(target.position.altitude);
      const samples = target.observations || [];
      let weightedAltitude = 0;
      let totalWeight = 0;
      samples.forEach(observation => {
        const raw = observation.raw || {};
        const observerAltitude = Number(raw.altitude);
        if (!Number.isFinite(observerAltitude)) return;
        let inferred = observerAltitude;
        const pitch = Number(raw.pitch);
        const rssi = Number(observation.rssi);
        if (Number.isFinite(pitch) && Number.isFinite(rssi) && target.sensor && typeof target.sensor.rangeFromRssi === 'function') {
          const range = target.sensor.rangeFromRssi(rssi);
          inferred += Math.sin(-pitch * Math.PI / 180) * range;
        }
        const verticalAccuracy = Math.max(2, Number(raw.verticalAccuracy) || Number(observation.accuracy) || 12);
        const signalWeight = Number.isFinite(rssi) ? clamp((rssi + 100) / 50, 0.2, 1) : 0.25;
        const weight = signalWeight / verticalAccuracy;
        weightedAltitude += inferred * weight;
        totalWeight += weight;
      });
      if (!totalWeight) return this.pose.altitude;
      const altitude = weightedAltitude / totalWeight;
      target.position.altitude = altitude;
      return altitude;
    }

    relativePosition(target) {
      const observer = this.observerPosition();
      const position = target && target.position;
      if (!observer || !position) return null;
      const meanLat = (observer.latitude + position.latitude) * 0.5;
      const east = (position.longitude - observer.longitude) * metersPerDegreeLng(meanLat);
      const north = (position.latitude - observer.latitude) * METERS_PER_DEGREE_LAT;
      const targetAltitude = this.resolveTargetAltitude(target);
      const up = Number.isFinite(targetAltitude) && Number.isFinite(observer.altitude) ? targetAltitude - observer.altitude : 0;
      const horizontal = Math.hypot(east, north);
      const distance = Math.hypot(horizontal, up);
      const bearing = wrapDegrees(Math.atan2(east, north) * 180 / Math.PI);
      const elevation = Math.atan2(up, Math.max(0.001, horizontal)) * 180 / Math.PI;
      return { east, north, up, horizontal, distance, bearing, elevation };
    }

    project(relative) {
      if (!relative || !this.scene) return null;
      const width = this.scene.clientWidth || 320;
      const height = this.scene.clientHeight || 320;
      const yaw = angularDifferenceDegrees(relative.bearing, this.pose.heading);
      const elevation = relative.elevation - this.pose.pitch;
      const radius = Math.min(width, height) * 0.43;
      const radialDistance = clamp(relative.distance / Math.max(1, this.rangeMeters), 0, 1.15) * radius;
      const yawRad = yaw * Math.PI / 180;
      const elevationRad = elevation * Math.PI / 180;
      const horizontalRadius = radialDistance * Math.cos(elevationRad);
      return {
        x: width / 2 + Math.sin(yawRad) * horizontalRadius,
        y: height / 2 - Math.sin(elevationRad) * radialDistance - Math.cos(yawRad) * horizontalRadius * 0.18,
        depth: Math.cos(yawRad) * Math.cos(elevationRad),
        distance: relative.distance
      };
    }

    render(engine) {
      if (!this.root || this.root.hidden || !this.targetLayer || !this.scene) return;
      this.rangeMeters = this.radar ? this.radar.rangeMeters : this.rangeMeters;
      if (this.headingLabel) this.headingLabel.textContent = `${Math.round(this.pose.heading)}°`;
      if (this.pitchLabel) this.pitchLabel.textContent = `${this.pose.pitch >= 0 ? '+' : ''}${Math.round(this.pose.pitch)}°`;
      if (this.rangeLabel) this.rangeLabel.textContent = `${Math.round(this.rangeMeters)} m`;

      this.targetLayer.replaceChildren();
      engine.sensors.forEach(sensor => {
        if (!sensor.enabled) return;
        sensor.targets.forEach(target => {
          if (!target.position) return;
          const relative = this.relativePosition(target);
          if (!relative || relative.distance > this.rangeMeters + (target.uncertaintyMeters || 0)) return;
          const projected = this.project(relative);
          if (!projected) return;
          const pxPerMeter = Math.min(this.scene.clientWidth || 320, this.scene.clientHeight || 320) * 0.43 / Math.max(1, this.rangeMeters);
          const radiusPx = clamp((target.uncertaintyMeters || 5) * pxPerMeter, 6, 110);
          const sphere = document.createElement('div');
          sphere.className = 'spatial-target-sphere';
          sphere.style.setProperty('--sensor-color', sensor.color);
          sphere.style.width = `${radiusPx * 2}px`;
          sphere.style.height = `${radiusPx * 2}px`;
          sphere.style.left = `${projected.x - radiusPx}px`;
          sphere.style.top = `${projected.y - radiusPx}px`;
          sphere.style.opacity = String(clamp(0.18 + (target.confidence || 0) * 0.66, 0.18, 0.86));
          sphere.style.zIndex = String(Math.round((projected.depth + 1) * 50));
          sphere.title = `${target.name || target.id} · ${Math.round(relative.distance)}m · ${relative.up >= 0 ? '+' : ''}${Math.round(relative.up)}m vertical`;
          this.targetLayer.appendChild(sphere);
          if ((target.confidence || 0) >= 0.62) {
            const dot = document.createElement('div');
            dot.className = 'spatial-target-dot';
            dot.style.setProperty('--sensor-color', sensor.color);
            dot.style.left = `${projected.x - 4}px`;
            dot.style.top = `${projected.y - 4}px`;
            dot.style.zIndex = String(Math.round((projected.depth + 1) * 50 + 1));
            this.targetLayer.appendChild(dot);
          }
        });
      });
    }
  }

  window.SpatialView = SpatialView;
})();
