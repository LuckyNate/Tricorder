(() => {
  if (!window.SpatialView) throw new Error('Hybrid horizon loaded before SpatialView');

  const BaseSpatialView = window.SpatialView;
  const INERTIAL_GAIN = 0.72;
  const GRAVITY_CORRECTION = 0.10;

  function shortestAngleDelta(target, current) {
    return ((target - current + 540) % 360) - 180;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  class HybridHorizonSpatialView extends BaseSpatialView {
    constructor(...args) {
      super(...args);
      this.hybridHorizon = null;
      this.mapPlane = document.getElementById('map');
    }

    gravityHorizon(projection) {
      if (!this.gravityVector) return null;

      const [gx, gy, gz] = this.gravityVector;
      let right;
      let up;

      switch (this.gravityDisplayRotation) {
        case 1:
          right = gy;
          up = -gx;
          break;
        case 2:
          right = -gx;
          up = -gy;
          break;
        case 3:
          right = -gy;
          up = gx;
          break;
        default:
          right = gx;
          up = gy;
          break;
      }

      if (Math.abs(up) < 0.001) return null;

      const forward = -gz;
      return {
        offset: projection.focalY * forward / up,
        angle: Math.atan(projection.focalY * right / (projection.focalX * up)) * 180 / Math.PI
      };
    }

    inertialHorizon(projection) {
      const pose = this.world && this.world.pose;
      if (!pose || !pose.orientation || !pose.orientation.hasMatrix) return null;

      const basis = pose.orientation.cameraBasis();
      const right = basis.right.up;
      const up = basis.up.up;
      const forward = basis.forward.up;
      if (Math.abs(up) < 0.001) return null;

      return {
        offset: projection.focalY * forward / up,
        angle: Math.atan(projection.focalY * right / (projection.focalX * up)) * 180 / Math.PI
      };
    }

    alignMapPlane(projection) {
      if (!this.mapPlane || !this.hybridHorizon) return;
      const elevation = this.cameraElevationDegrees();
      const tilt = clamp(78 + elevation, 8, 89);
      this.mapPlane.style.transform = `translate3d(0,${this.hybridHorizon.offset}px,0) rotate(${this.hybridHorizon.angle}deg) perspective(${Math.max(480, projection.focalY * 1.6)}px) rotateX(${tilt}deg) scale(1.45)`;
    }

    renderHorizon() {
      if (!this.horizon || !this.scene) return;
      const projection = this.effectiveProjection();
      const gravity = this.gravityHorizon(projection);
      const inertial = this.inertialHorizon(projection);

      if (!gravity) {
        super.renderHorizon();
        this.horizon.style.display = 'none';
        return;
      }

      if (!this.hybridHorizon) {
        this.hybridHorizon = { ...gravity };
      }

      if (inertial) {
        this.hybridHorizon.offset += (inertial.offset - this.hybridHorizon.offset) * INERTIAL_GAIN;
        this.hybridHorizon.angle += shortestAngleDelta(inertial.angle, this.hybridHorizon.angle) * INERTIAL_GAIN;
      }

      this.hybridHorizon.offset += (gravity.offset - this.hybridHorizon.offset) * GRAVITY_CORRECTION;
      this.hybridHorizon.angle += shortestAngleDelta(gravity.angle, this.hybridHorizon.angle) * GRAVITY_CORRECTION;

      this.horizon.style.display = 'none';
      this.alignMapPlane(projection);
    }
  }

  window.SpatialView = HybridHorizonSpatialView;
})();
