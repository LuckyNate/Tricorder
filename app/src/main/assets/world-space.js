(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapDegrees(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function angleDelta(a, b) {
    return ((Number(a) - Number(b) + 540) % 360) - 180;
  }

  function metersPerDegreeLng(latitude) {
    return METERS_PER_DEGREE_LAT * Math.cos(Number(latitude) * DEG);
  }

  class SpatialPose {
    constructor() {
      this.latitude = null;
      this.longitude = null;
      this.accuracy = null;
      this.altitude = null;
      this.verticalAccuracy = null;
      this.heading = 0;
      this.pitch = 0;
      this.roll = 0;
    }

    update(values = {}) {
      ['latitude', 'longitude', 'accuracy', 'altitude', 'verticalAccuracy', 'pitch', 'roll'].forEach(key => {
        if (Number.isFinite(Number(values[key]))) this[key] = Number(values[key]);
      });
      if (Number.isFinite(Number(values.heading))) this.heading = wrapDegrees(values.heading);
      return this;
    }

    hasLocation() {
      return Number.isFinite(this.latitude) && Number.isFinite(this.longitude);
    }
  }

  class WorldVector3 {
    constructor({ east = 0, north = 0, up = 0, horizontalUncertainty = 1, verticalUncertainty = 1 } = {}) {
      this.east = Number(east) || 0;
      this.north = Number(north) || 0;
      this.up = Number(up) || 0;
      this.horizontalDistance = Math.hypot(this.east, this.north);
      this.distance = Math.hypot(this.horizontalDistance, this.up);
      this.bearing = wrapDegrees(Math.atan2(this.east, this.north) / DEG);
      this.elevation = Math.atan2(this.up, Math.max(0.001, this.horizontalDistance)) / DEG;
      this.horizontalUncertainty = Math.max(1, Number(horizontalUncertainty) || 1);
      this.verticalUncertainty = Math.max(1, Number(verticalUncertainty) || 1);
    }
  }

  class VerticalEstimator {
    estimate(target, pose, horizontalDistance, rangeMeters) {
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

      if (!samples.length || !Number.isFinite(pose.altitude)) {
        return {
          altitude: pose.altitude,
          uncertainty: Math.max(Number(target.uncertaintyMeters) || 5, rangeMeters * 0.55),
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
        const signalBias = clamp((Number(observation.rssi) - meanRssi + 8) / 16, 0.08, 1);
        const accuracy = Math.max(4, Number(observation.accuracy) || 25);
        const weight = signalBias / accuracy;
        weightedElevation += elevation * weight;
        weightTotal += weight;
      });

      if (!weightTotal) {
        return {
          altitude: pose.altitude,
          uncertainty: Math.max(Number(target.uncertaintyMeters) || 5, rangeMeters * 0.55),
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
        Number(pose.verticalAccuracy) || 0
      );

      return {
        altitude: pose.altitude + clamp(verticalOffset, -rangeMeters, rangeMeters),
        uncertainty: clamp(verticalUncertainty, 3, rangeMeters),
        confidence: clamp(samples.length / 16, 0, 0.65)
      };
    }

    best(target, candidate) {
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
  }

  class TopDownProjector {
    project(vector, metersPerPixel, width, height) {
      const scale = Math.max(0.0001, Number(metersPerPixel) || 1);
      return {
        x: width * 0.5 + vector.east / scale,
        y: height * 0.5 - vector.north / scale
      };
    }

    rotationDegrees(pose) {
      return -wrapDegrees(pose.heading || 0);
    }
  }

  class CameraProjector {
    cameraElevationDegrees(pose) {
      return -Number(pose.pitch || 0);
    }

    relative(vector, pose) {
      const yaw = angleDelta(vector.bearing, pose.heading || 0);
      const pitch = vector.elevation - this.cameraElevationDegrees(pose);
      const distance = Math.max(0.001, vector.distance);
      const yawRad = yaw * DEG;
      const pitchRad = pitch * DEG;

      let x = distance * Math.cos(pitchRad) * Math.sin(yawRad);
      let y = distance * Math.sin(pitchRad);
      const z = distance * Math.cos(pitchRad) * Math.cos(yawRad);

      const roll = Number(pose.roll || 0) * DEG;
      const cos = Math.cos(roll);
      const sin = Math.sin(roll);
      const rolledX = x * cos - y * sin;
      const rolledY = x * sin + y * cos;
      x = rolledX;
      y = rolledY;
      return { x, y, z };
    }

    project(vector, pose, projection) {
      const camera = this.relative(vector, pose);
      if (camera.z <= 0.05) return null;
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
  }

  class WorldSpaceModel {
    constructor() {
      this.pose = new SpatialPose();
      this.rangeMeters = 20;
      this.verticalEstimator = new VerticalEstimator();
      this.topDown = new TopDownProjector();
      this.camera = new CameraProjector();
      this.version = 0;
    }

    setRange(meters) {
      this.rangeMeters = Number(meters) || 20;
      this.version += 1;
    }

    setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
      this.pose.update({ latitude, longitude, accuracy, altitude, verticalAccuracy });
      this.version += 1;
    }

    setPose(values = {}) {
      this.pose.update(values);
      this.version += 1;
    }

    setHeading(heading) {
      this.pose.update({ heading });
      this.version += 1;
    }

    horizontalOffset(position) {
      if (!this.pose.hasLocation() || !position) return null;
      const latitude = Number(position.latitude);
      const longitude = Number(position.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const meanLat = (this.pose.latitude + latitude) * 0.5;
      return {
        east: (longitude - this.pose.longitude) * metersPerDegreeLng(meanLat),
        north: (latitude - this.pose.latitude) * METERS_PER_DEGREE_LAT
      };
    }

    resolveTarget(target) {
      if (!target || !target.position || !this.pose.hasLocation()) return null;
      const horizontal = this.horizontalOffset(target.position);
      if (!horizontal) return null;
      const horizontalDistance = Math.hypot(horizontal.east, horizontal.north);
      const verticalCandidate = this.verticalEstimator.estimate(target, this.pose, horizontalDistance, this.rangeMeters);
      const vertical = this.verticalEstimator.best(target, verticalCandidate);
      const up = Number.isFinite(vertical.altitude) && Number.isFinite(this.pose.altitude)
        ? vertical.altitude - this.pose.altitude
        : 0;
      const vector = new WorldVector3({
        east: horizontal.east,
        north: horizontal.north,
        up,
        horizontalUncertainty: Number(target.uncertaintyMeters) || 5,
        verticalUncertainty: vertical.uncertainty || Number(target.uncertaintyMeters) || 5
      });

      target.spatial = {
        east: vector.east,
        north: vector.north,
        up: vector.up,
        altitude: vertical.altitude,
        bearing: vector.bearing,
        elevation: vector.elevation,
        distance: vector.distance,
        verticalUncertaintyMeters: vector.verticalUncertainty,
        horizontalUncertaintyMeters: vector.horizontalUncertainty,
        confidence: Math.max(Number(target.confidence) || 0, vertical.confidence || 0)
      };
      return vector;
    }

    projectTopDown(target, metersPerPixel, width, height) {
      const vector = this.resolveTarget(target);
      return vector ? this.topDown.project(vector, metersPerPixel, width, height) : null;
    }

    mapRotationDegrees() {
      return this.topDown.rotationDegrees(this.pose);
    }

    projectCamera(target, projection) {
      const vector = this.resolveTarget(target);
      if (!vector) return null;
      const point = this.camera.project(vector, this.pose, projection);
      return point ? { point, vector } : null;
    }
  }

  window.WorldSpace = {
    SpatialPose,
    WorldVector3,
    VerticalEstimator,
    TopDownProjector,
    CameraProjector,
    WorldSpaceModel,
    clamp,
    wrapDegrees
  };
})();