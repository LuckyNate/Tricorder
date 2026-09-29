(() => {
  if (!window.SpatialView) throw new Error('Hybrid horizon loaded before SpatialView');

  const BaseSpatialView = window.SpatialView;
  const INERTIAL_GAIN = 0.72;
  const GRAVITY_CORRECTION = 0.10;

  function shortestAngleDelta(target, current) {
    return ((target - current + 540) % 360) - 180;
  }

  class HybridHorizonSpatialView extends BaseSpatialView {
    constructor(...args) {
      super(...args);
      this.hybridHorizon = null;
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

    renderHorizon() {
      if (!this.horizon || !this.scene) return;
      const projection = this.effectiveProjection();
      const gravity = this.gravityHorizon(projection);
      const inertial = this.inertialHorizon(projection);

      if (!gravity) {
        super.renderHorizon();
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

      this.horizon.style.display = 'block';
      this.horizon.style.transform = `translate3d(0,${this.hybridHorizon.offset}px,0) rotate(${this.hybridHorizon.angle}deg)`;
    }
  }

  window.SpatialView = HybridHorizonSpatialView;
})();
