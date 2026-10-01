(() => {
  const METERS_PER_DEGREE_LAT = 111320;
  const DEG = Math.PI / 180;

  function finite(value) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }

  function wrapDegrees(value) {
    return ((Number(value) % 360) + 360) % 360;
  }

  function normalize(vector) {
    const length = Math.hypot(vector.x, vector.y, vector.z) || 1;
    return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
  }

  class GeoPoint {
    constructor(latitude, longitude, elevationMSL = null) {
      this.latitude = finite(latitude) ? Number(latitude) : null;
      this.longitude = finite(longitude) ? Number(longitude) : null;
      this.elevationMSL = finite(elevationMSL) ? Number(elevationMSL) : null;
    }

    isHorizontalValid() {
      return finite(this.latitude) && finite(this.longitude);
    }

    is3DValid() {
      return this.isHorizontalValid() && finite(this.elevationMSL);
    }
  }

  class TerrainSample extends GeoPoint {
    constructor(latitude, longitude, elevationMSL) {
      super(latitude, longitude, elevationMSL);
    }
  }

  class WorldVector {
    constructor(east = 0, up = 0, north = 0) {
      this.x = Number(east);
      this.y = Number(up);
      this.z = Number(north);
    }
  }

  class CameraBasis {
    constructor(right, up, forward) {
      this.right = right;
      this.up = up;
      this.forward = forward;
    }
  }

  class Projection {
    constructor(width = 1, height = 1, verticalFovDegrees = 60, near = 0.05, far = 4000) {
      this.width = Math.max(1, Number(width) || 1);
      this.height = Math.max(1, Number(height) || 1);
      this.verticalFovDegrees = Number(verticalFovDegrees) || 60;
      this.near = Math.max(0.01, Number(near) || 0.05);
      this.far = Math.max(this.near + 1, Number(far) || 4000);
    }
  }

  class DeviceOrientation {
    constructor() {
      this.rawMatrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      this.displayRotation = 0;
      this.declinationDegrees = 0;
      this.hasMatrix = false;
    }

    set(matrix, displayRotation = 0, declinationDegrees = 0) {
      if (!Array.isArray(matrix) || matrix.length !== 9 || !matrix.every(finite)) return false;
      this.rawMatrix = matrix.map(Number);
      this.displayRotation = Number(displayRotation) || 0;
      this.declinationDegrees = finite(declinationDegrees) ? Number(declinationDegrees) : 0;
      this.hasMatrix = true;
      return true;
    }

    screenRightDeviceAxis() {
      switch (this.displayRotation) {
        case 1: return { x: 0, y: 1, z: 0 };
        case 2: return { x: -1, y: 0, z: 0 };
        case 3: return { x: 0, y: -1, z: 0 };
        default: return { x: 1, y: 0, z: 0 };
      }
    }

    screenTopDeviceAxis() {
      switch (this.displayRotation) {
        case 1: return { x: -1, y: 0, z: 0 };
        case 2: return { x: 0, y: -1, z: 0 };
        case 3: return { x: 1, y: 0, z: 0 };
        default: return { x: 0, y: 1, z: 0 };
      }
    }

    deviceToWorld(deviceVector) {
      const m = this.rawMatrix;
      const dx = Number(deviceVector.x) || 0;
      const dy = Number(deviceVector.y) || 0;
      const dz = Number(deviceVector.z) || 0;
      const magneticEast = m[0] * dx + m[1] * dy + m[2] * dz;
      const magneticNorth = m[3] * dx + m[4] * dy + m[5] * dz;
      const up = m[6] * dx + m[7] * dy + m[8] * dz;
      const angle = this.declinationDegrees * DEG;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      return normalize({
        x: magneticEast * cos + magneticNorth * sin,
        y: up,
        z: -magneticEast * sin + magneticNorth * cos
      });
    }

    cameraBasis() {
      return new CameraBasis(
        this.deviceToWorld(this.screenRightDeviceAxis()),
        this.deviceToWorld(this.screenTopDeviceAxis()),
        this.deviceToWorld({ x: 0, y: 0, z: -1 })
      );
    }
  }

  class ObserverPose {
    constructor(cameraHeightAGL = 5) {
      this.latitude = null;
      this.longitude = null;
      this.accuracy = null;
      this.rawAltitude = null;
      this.verticalAccuracy = null;
      this.groundElevationMSL = null;
      this.cameraHeightAGL = Number(cameraHeightAGL) || 5;
      this.cameraElevationMSL = null;
      this.heading = 0;
      this.pitch = 0;
      this.roll = 0;
      this.orientation = new DeviceOrientation();
    }

    setLocation(latitude, longitude, accuracy, rawAltitude, verticalAccuracy) {
      if (finite(latitude)) this.latitude = Number(latitude);
      if (finite(longitude)) this.longitude = Number(longitude);
      if (finite(accuracy)) this.accuracy = Number(accuracy);
      if (finite(rawAltitude)) this.rawAltitude = Number(rawAltitude);
      if (finite(verticalAccuracy)) this.verticalAccuracy = Number(verticalAccuracy);
    }

    setHeading(heading, pitch, roll) {
      if (finite(heading)) this.heading = wrapDegrees(heading);
      if (finite(pitch)) this.pitch = Number(pitch);
      if (finite(roll)) this.roll = Number(roll);
    }

    setGroundElevation(elevationMSL) {
      if (!finite(elevationMSL)) return false;
      this.groundElevationMSL = Number(elevationMSL);
      this.cameraElevationMSL = this.groundElevationMSL + this.cameraHeightAGL;
      return true;
    }

    setOrientation(matrix, displayRotation, declinationDegrees) {
      return this.orientation.set(matrix, displayRotation, declinationDegrees);
    }

    hasLocation() {
      return finite(this.latitude) && finite(this.longitude);
    }

    hasResolvedCamera() {
      return this.hasLocation() && finite(this.cameraElevationMSL);
    }

    cameraGeoPoint() {
      return this.hasResolvedCamera()
        ? new GeoPoint(this.latitude, this.longitude, this.cameraElevationMSL)
        : null;
    }
  }

  class WorldSpaceModel {
    constructor(cameraHeightAGL = 5) {
      this.pose = new ObserverPose(cameraHeightAGL);
      this.origin = null;
      this.version = 0;
    }

    setLocation(latitude, longitude, accuracy, rawAltitude, verticalAccuracy) {
      this.pose.setLocation(latitude, longitude, accuracy, rawAltitude, verticalAccuracy);
      this.version += 1;
    }

    setHeading(heading, pitch, roll) {
      this.pose.setHeading(heading, pitch, roll);
      this.version += 1;
    }

    setOrientation(matrix, displayRotation, declinationDegrees) {
      const changed = this.pose.setOrientation(matrix, displayRotation, declinationDegrees);
      if (changed) this.version += 1;
      return changed;
    }

    resolveGroundElevation(elevationMSL) {
      if (!this.pose.setGroundElevation(elevationMSL)) return false;
      if (!this.origin && this.pose.hasResolvedCamera()) {
        this.origin = this.pose.cameraGeoPoint();
      }
      this.version += 1;
      return true;
    }

    resetOrigin() {
      this.origin = this.pose.cameraGeoPoint();
      this.version += 1;
    }

    metersPerDegreeLongitude(latitude) {
      return METERS_PER_DEGREE_LAT * Math.cos(Number(latitude) * DEG);
    }

    geoToWorld(point) {
      if (!(point instanceof GeoPoint)) {
        point = new GeoPoint(point && point.latitude, point && point.longitude, point && point.elevationMSL);
      }
      if (!this.origin || !this.origin.is3DValid() || !point.is3DValid()) return null;
      const meanLatitude = (this.origin.latitude + point.latitude) * 0.5;
      return new WorldVector(
        (point.longitude - this.origin.longitude) * this.metersPerDegreeLongitude(meanLatitude),
        point.elevationMSL - this.origin.elevationMSL,
        (point.latitude - this.origin.latitude) * METERS_PER_DEGREE_LAT
      );
    }

    observerWorldPosition() {
      const point = this.pose.cameraGeoPoint();
      return point ? this.geoToWorld(point) : null;
    }

    terrainWorldPosition(latitude, longitude, elevationMSL) {
      return this.geoToWorld(new TerrainSample(latitude, longitude, elevationMSL));
    }

    cameraBasis() {
      return this.pose.orientation.cameraBasis();
    }
  }

  window.WorldSpace = {
    GeoPoint,
    TerrainSample,
    WorldVector,
    CameraBasis,
    Projection,
    DeviceOrientation,
    ObserverPose,
    WorldSpaceModel,
    finite,
    wrapDegrees,
    METERS_PER_DEGREE_LAT
  };
})();