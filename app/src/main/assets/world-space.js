(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function wrapDegrees(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function finite(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function metersPerDegreeLng(latitude) {
    return METERS_PER_DEGREE_LAT * Math.cos(Number(latitude) * DEG);
  }

  function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return {
      x: vector.x / length,
      y: vector.y / length,
      z: vector.z / length
    };
  }

  function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
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
      if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(finite)) return false;
      this.rawMatrix = matrix.map(Number);
      this.displayRotation = Number(displayRotation) || 0;
      this.declinationDegrees = finite(declinationDegrees) ? Number(declinationDegrees) : 0;
      this.hasMatrix = true;
      return true;
    }

    // Android world axes are east, north, up. Convert once at the boundary
    // into Tricorder world axes: X=east/right, Y=up, Z=north/forward.
    deviceToMagneticWorld(deviceVector) {
      const m = this.rawMatrix;
      const dx = Number(deviceVector.x) || 0;
      const dy = Number(deviceVector.y) || 0;
      const dz = Number(deviceVector.z) || 0;
      const east = m[0] * dx + m[1] * dy + m[2] * dz;
      const north = m[3] * dx + m[4] * dy + m[5] * dz;
      const up = m[6] * dx + m[7] * dy + m[8] * dz;
      return { x: east, y: up, z: north };
    }

    magneticWorldToTrueWorld(vector) {
      const angle = this.declinationDegrees * DEG;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return {
        x: vector.x * cos + vector.z * sin,
        y: vector.y,
        z: -vector.x * sin + vector.z * cos
      };
    }

    worldVector(deviceVector) {
      return normalize(this.magneticWorldToTrueWorld(this.deviceToMagneticWorld(deviceVector)));
    }

    cameraBasis() {
      return {
        right: this.worldVector(DeviceAxes.screenRight(this.displayRotation)),
        up: this.worldVector(DeviceAxes.screenTop(this.displayRotation)),
        forward: this.worldVector(DeviceAxes.rearCameraForward())
      };
    }

    mapHeadingDegrees(fallbackHeading = 0) {
      if (!this.hasMatrix) return wrapDegrees(fallbackHeading);
      const basis = this.cameraBasis();
      const forward = basis.forward;
      const horizontal = Math.hypot(forward.x, forward.z);
      if (horizontal >= 0.05) return wrapDegrees(Math.atan2(forward.x, forward.z) / DEG);
      return wrapDegrees(Math.atan2(basis.up.x, basis.up.z) / DEG);
    }

    cameraElevationDegrees(fallbackPitch = 0) {
      if (!this.hasMatrix) return -Number(fallbackPitch || 0);
      return Math.asin(clamp(this.cameraBasis().forward.y, -1, 1)) / DEG;
    }

    cameraRollDegrees(fallbackRoll = 0) {
      if (!this.hasMatrix) return Number(fallbackRoll || 0);
      const basis = this.cameraBasis();
      return Math.atan2(-basis.right.y, basis.up.y) / DEG;
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
        if (finite(values[key])) this[key] = Number(values[key]);
      });
      if (finite(values.heading)) this.heading = wrapDegrees(values.heading);
      if (Array.isArray(values.rotationMatrix) && values.rotationMatrix.length === 9 && values.rotationMatrix.every(finite)) {
        this.rotationMatrix = values.rotationMatrix.map(Number);
      }
      if (this.rotationMatrix) {
        this.orientation.setAndroidMatrix(this.rotationMatrix, this.displayRotation, this.declinationDegrees);
      }
      return this;
    }

    hasLocation() {
      return finite(this.latitude) && finite(this.longitude);
    }

    hasAltitude() {
      return finite(this.altitude);
    }
  }

  class WorldVector3 {
    constructor({ x = 0, y = 0, z = 0, horizontalUncertainty = 1, verticalUncertainty = 1 } = {}) {
      this.x = Number(x);
      this.y = Number(y);
      this.z = Number(z);
      this.horizontalDistance = Math.hypot(this.x, this.z);
      this.distance = Math.hypot(this.horizontalDistance, this.y);
      this.bearing = wrapDegrees(Math.atan2(this.x, this.z) / DEG);
      this.elevation = Math.atan2(this.y, Math.max(0.001, this.horizontalDistance)) / DEG;
      this.horizontalUncertainty = Math.max(1, Number(horizontalUncertainty) || 1);
      this.verticalUncertainty = Math.max(1, Number(verticalUncertainty) || 1);
    }
  }

  class VerticalEstimator {
    estimate(target, pose, horizontalDistance, rangeMeters) {
      if (target.position && finite(target.position.altitude)) {
        return {
          altitude: Number(target.position.altitude),
          uncertainty: Math.max(2, Number(target.uncertaintyMeters) || 5),
          confidence: Number(target.confidence) || 0
        };
      }

      const baseUncertainty = Math.max(
        3,
        Number(target.uncertaintyMeters) || 5,
        finite(pose.verticalAccuracy) ? Number(pose.verticalAccuracy) : 0,
        Math.min(Number(rangeMeters) || 20, Math.max(3, horizontalDistance * 0.5))
      );

      return {
        altitude: pose.hasAltitude() ? pose.altitude : null,
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
        x: width * 0.5 + vector.x / scale,
        y: height * 0.5 - vector.z / scale
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
        return {
          x: dot(vector, basis.right),
          y: dot(vector, basis.up),
          z: dot(vector, basis.forward)
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
      if (!finite(camera.x) || !finite(camera.y) || !finite(camera.z) || camera.z <= 0.05) return null;
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
      if (!this.pose.hasLocation() || !position || !finite(position.latitude) || !finite(position.longitude)) return null;
      const latitude = Number(position.latitude);
      const longitude = Number(position.longitude);
      const meanLatitude = (this.pose.latitude + latitude) * 0.5;
      return {
        x: (longitude - this.pose.longitude) * metersPerDegreeLng(meanLatitude),
        z: (latitude - this.pose.latitude) * METERS_PER_DEGREE_LAT
      };
    }

    geographicVector(position) {
      if (!this.pose.hasLocation() || !this.pose.hasAltitude() || !position || !finite(position.altitude)) return null;
      const horizontal = this.horizontalOffset(position);
      if (!horizontal) return null;
      return new WorldVector3({
        x: horizontal.x,
        y: Number(position.altitude) - Number(this.pose.altitude),
        z: horizontal.z,
        horizontalUncertainty: 1,
        verticalUncertainty: 1
      });
    }

    resolveTarget(target) {
      if (!target || !target.position || !this.pose.hasLocation()) return null;
      const horizontal = this.horizontalOffset(target.position);
      if (!horizontal) return null;
      const horizontalDistance = Math.hypot(horizontal.x, horizontal.z);
      const vertical = this.verticalEstimator.best(
        target,
        this.verticalEstimator.estimate(target, this.pose, horizontalDistance, this.rangeMeters)
      );
      const y = finite(vertical.altitude) && this.pose.hasAltitude()
        ? Number(vertical.altitude) - Number(this.pose.altitude)
        : 0;
      const vector = new WorldVector3({
        x: horizontal.x,
        y,
        z: horizontal.z,
        horizontalUncertainty: Number(target.uncertaintyMeters) || 5,
        verticalUncertainty: vertical.uncertainty || Number(target.uncertaintyMeters) || 5
      });

      target.spatial = {
        x: vector.x,
        y: vector.y,
        z: vector.z,
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
    wrapDegrees,
    finite
  };
})();