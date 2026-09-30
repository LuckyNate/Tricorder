(() => {
  if (!window.ScannerCore || !window.WorldSpace) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;

  class SharedRadarView extends BaseRadarView {
    constructor(world = new WorldSpaceModel()) {
      super();
      this.world = world;
      this.world.setRange(this.rangeMeters);
    }

    setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy) {
      super.setLocation(latitude, longitude, accuracy);
      this.world.setLocation(latitude, longitude, accuracy, altitude, verticalAccuracy);
    }

    setHeading(degrees) {
      if (!finite(degrees)) return;
      this.heading = wrapDegrees(Number(degrees));
      this.world.setHeading(this.heading);
      if (this.rotatorEl) {
        this.rotatorEl.style.transform = `rotate(${-this.heading}deg) scale(1.18)`;
      }
    }

    setRange(meters) {
      this.world.setRange(meters);
      super.setRange(meters);
    }

    render() {
      if (this.targetLayer) this.targetLayer.replaceChildren();
      if (this.pingLayer) this.pingLayer.replaceChildren();
    }

    ping() {
      return false;
    }
  }

  class SpatialView {
    constructor(radar) {
      if (!radar || !radar.world) throw new Error('SpatialView requires shared world model');
      this.radar = radar;
      this.world = radar.world;
      this.pose = this.world.pose;
      this.root = document.getElementById('threeDView');
      this.scene = document.getElementById('spatialScene');
      this.rangeMeters = this.world.rangeMeters;
      this.active = false;
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();
    }

    setActive(active) {
      this.active = Boolean(active);
      if (this.root) this.root.dataset.mapFirst = this.active ? 'true' : 'false';
      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    setGravityVector() {
      // Reserved for the next 3D stage. Map-first baseline performs no projection.
    }

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
      if (this.active && typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }

    render() {
      if (!this.active) return;
      if (typeof this.radar.syncReferenceOverlay === 'function') {
        this.radar.syncReferenceOverlay();
      }
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();