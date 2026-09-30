(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapDegrees(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function metersPerDegreeLng(latitude) {
    return METERS_PER_DEGREE_LAT * Math.cos(Number(latitude) * DEG);
  }

  function normalize(vector) {
    const length = Math.hypot(vector.east, vector.north, vector.up) || 1;
    return {
      east: vector.east / length,
      north: vector.north / length,
      up: vector.up / length
    };
  }

  function dot(a, b) {
    return a.east * b.east + a.north * b.north + a.up * b.up;
  }

  class DeviceAxes {
    static screenRight(displayRotation = 0) {
      switch (Number(displayRotation)) {
        case 1: return { x: 0, y: 1, z: 0 };
        case 2: return { x: -1, y: 0, z: 0 };
        case 3: return { x: 0, y: -1, z: 0 };
        default: return { x: 1, y: 0, z: 0 };
      }
    }

    static screenTop(displayRotation = 0) {
      switch (Number(displayRotation)) {
        case 1: return { x: -1, y: 0, z: 0 };
        case 2: return { x: 0, y: -1, z: 0 };
        case 3: return { x: 1, y: 0, z: 0 };
        default: return { x: 0, y: 1, z: 0 };
      }
    }

    static rearCameraForward() {
      return { x: 0, y: 0, z: -1 };
    }
  }

  class DeviceOrientation {
    constructor() {
      this.rawMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.displayRotation = 0;
      this.declinationDegrees = 0;
      this.hasMatrix = false;
    }

    setAndroidMatrix(matrix, displayRotation = 0, declinationDegrees = 0) {
      if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(value => Number.isFinite(Number(value)))) {
        return false;
      }
      this.rawMatrix = matrix.map(Number);
      this.displayRotation = Number(displayRotation) || 0;
      this.declinationDegrees = Number(declinationDegrees) || 0;
      this.hasMatrix = true;
      return true;
    }

    deviceToMagneticWorld(deviceVector) {
      const m = this.rawMatrix;
      const x = Number(deviceVector.x) || 0;
      const y = Number(deviceVector.y) || 0;
      const z = Number(deviceVector.z) || 0;
      return {
        east: m[0] * x + m[1] * y + m[2] * z,
        north: m[3] * x + m[4] * y + m[5] * z,
        up: m[6] * x + m[7] * y + m[8] * z
      };
    }

    magneticWorldToTrueEnu(vector) {
      const angle = this.declinationDegrees * DEG;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        east: vector.east * cos + vector.north * sin,
        north: -vector.east * sin + vector.north * cos,
        up: vector.up
      };
    }

    worldVector(deviceVector) {
      return normalize(this.magneticWorldToTrueEnu(this.deviceToMagneticWorld(deviceVector)));
    }

    screenRight() {
      return this.worldVector(DeviceAxes.screenRight(this.displayRotation));
    }

    screenTop() {
      return this.worldVector(DeviceAxes.screenTop(this.displayRotation));
    }

    cameraForward() {
      return this.worldVector(DeviceAxes.rearCameraForward());
    }

    cameraBasis() {
      return {
        right: this.screenRight(),
        up: this.screenTop(),
        forward: this.cameraForward()
      };
    }

    mapHeadingDegrees(fallbackHeading = 0) {
      if (!this.hasMatrix) return wrapDegrees(fallbackHeading);
      const top = this.screenTop();
      const horizontal = Math.hypot(top.east, top.north);
      if (horizontal < 0.05) return wrapDegrees(fallbackHeading);
      return wrapDegrees(Math.atan2(top.east, top.north) / DEG);
    }

    cameraElevationDegrees(fallbackPitch = 0) {
      if (!this.hasMatrix) return -Number(fallbackPitch || 0);
      const forward = this.cameraForward();
      return Math.asin(clamp(forward.up, -1, 1)) / DEG;
    }

    cameraRollDegrees(fallbackRoll = 0) {
      if (!this.hasMatrix) return Number(fallbackRoll || 0);
      const basis = this.cameraBasis();
      return Math.atan2(-basis.right.up, basis.up.up) / DEG;
    }
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
      this.rotationMatrix = null;
      this.displayRotation = 0;
      this.declinationDegrees = 0;
      this.orientation = new DeviceOrientation();
    }

    update(values = {}) {
      ['latitude', 'longitude', 'accuracy', 'altitude', 'verticalAccuracy', 'pitch', 'roll', 'displayRotation', 'declinationDegrees'].forEach(key => {
        const value = values[key];
        if (value !== null && value !== undefined && Number.isFinite(Number(value))) {
          this[key] = Number(value);
        }
      });
      if (values.heading !== null && values.heading !== undefined && Number.isFinite(Number(values.heading))) {
        this.heading = wrapDegrees(values.heading);
      }
      if (Array.isArray(values.rotationMatrix) && values.rotationMatrix.length === 9) {
        this.rotationMatrix = values.rotationMatrix.map(Number);
        this.orientation.setAndroidMatrix(this.rotationMatrix, this.displayRotation, this.declinationDegrees);
      } else if (this.rotationMatrix) {
        this.orientation.setAndroidMatrix(this.rotationMatrix, this.displayRotation, this.declinationDegrees);
      }
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

      const baseUncertainty = Math.max(
        3,
        Number(target.uncertaintyMeters) || 5,
        Number(pose.verticalAccuracy) || 0,
        Math.min(Number(rangeMeters) || 20, Math.max(3, horizontalDistance * 0.5))
      );

      return {
        altitude: Number.isFinite(pose.altitude) ? pose.altitude : null,
        uncertainty: baseUncertainty,
        confidence: 0
      };
    }

    best(target, candidate) {
      target.spatialVertical = candidate;
      return candidate;
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
      return -pose.orientation.mapHeadingDegrees(pose.heading);
    }
  }

  class CameraProjector {
    cameraElevationDegrees(pose) {
      return pose.orientation.cameraElevationDegrees(pose.pitch);
    }

    cameraRollDegrees(pose) {
      return pose.orientation.cameraRollDegrees(pose.roll);
    }

    relative(vector, pose) {
      if (pose.orientation.hasMatrix) {
        const basis = pose.orientation.cameraBasis();
        const world = { east: vector.east, north: vector.north, up: vector.up };
        return {
          x: dot(world, basis.right),
          y: dot(world, basis.up),
          z: dot(world, basis.forward)
        };
      }

      const yaw = (vector.bearing - Number(pose.heading || 0)) * DEG;
      const pitch = (vector.elevation + Number(pose.pitch || 0)) * DEG;
      const distance = Math.max(0.001, vector.distance);
      let x = distance * Math.cos(pitch) * Math.sin(yaw);
      let y = distance * Math.sin(pitch);
      const z = distance * Math.cos(pitch) * Math.cos(yaw);
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

    mapHeadingDegrees() {
      return this.pose.orientation.mapHeadingDegrees(this.pose.heading);
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
    DeviceAxes,
    DeviceOrientation,
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
