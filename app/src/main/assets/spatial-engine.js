(() => {
  if (!window.ScannerCore || !window.WorldSpace || !window.maplibregl) {
    throw new Error('Spatial engine loaded before dependencies');
  }

  const BaseRadarView = window.ScannerCore.RadarView;
  const { WorldSpaceModel, wrapDegrees, finite } = window.WorldSpace;
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

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
      this.map3d = null;
      this.mapReady = false;
      this.initScene();
    }

    initScene() {
      if (!this.scene) return;
      this.scene.replaceChildren();

      this.mapSurface = document.createElement('div');
      this.mapSurface.className = 'spatial-map-mesh';
      this.scene.appendChild(this.mapSurface);

      this.map3d = new window.maplibregl.Map({
        container: this.mapSurface,
        style: MAP_STYLE,
        interactive: false,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 0,
        center: [0, 0],
        zoom: 0,
        bearing: 0,
        pitch: 67
      });

      this.map3d.on('load', () => {
        this.mapReady = true;
        this.sync3dMap();
      });
    }

    sync3dMap() {
      if (!this.map3d || !this.mapReady || !this.radar.location) return;
      this.map3d.resize();
      const visualZoom = typeof this.radar.zoomForRange === 'function' ? this.radar.zoomForRange() : 18;
      this.map3d.jumpTo({
        center: [this.radar.location.longitude, this.radar.location.latitude],
        zoom: Math.max(0, visualZoom - 1),
        bearing: finite(this.radar.heading) ? Number(this.radar.heading) : 0,
        pitch: 67
      });
    }

    setActive(active) {
      this.active = Boolean(active);
      if (this.root) this.root.dataset.mapFirst = this.active ? 'true' : 'false';
      if (this.active) this.sync3dMap();
    }

    setPose(values = {}) {
      this.world.setPose(values);
      this.pose = this.world.pose;
      if (this.active) this.sync3dMap();
    }

    setGravityVector() {}

    setRange(meters) {
      this.world.setRange(meters);
      this.rangeMeters = this.world.rangeMeters;
      if (this.active) this.sync3dMap();
    }

    render() {
      if (!this.active) return;
      this.sync3dMap();
    }
  }

  window.ScannerCore.RadarView = SharedRadarView;
  window.SpatialView = SpatialView;
})();