(() => {
  if (!window.ScannerCore || !window.maplibregl) return;

  const BaseRadarView = window.ScannerCore.RadarView;
  const REFERENCE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const TERRAIN_SOURCE_ID = 'tricorder-terrain';
  const TERRAIN_SOURCE_URL = 'https://tiles.mapterhorn.com/tilejson.json';

  class ReferenceOverlayRadarView extends BaseRadarView {
    constructor(...args) {
      super(...args);
      this.referenceOverlayMap = null;
      this.referenceOverlayReady = false;
      this.initReferenceOverlay();
    }

    initReferenceOverlay() {
      if (!this.mapEl || !this.targetLayer || !this.pingLayer) return;

      const overlay = document.createElement('div');
      overlay.className = 'map-reference-overlay';
      overlay.style.position = 'absolute';
      overlay.style.inset = '0';
      overlay.style.pointerEvents = 'none';
      overlay.style.opacity = '0';
      overlay.style.background = 'transparent';
      this.mapEl.insertBefore(overlay, this.pingLayer);

      this.referenceOverlayMap = new window.maplibregl.Map({
        container: overlay,
        style: REFERENCE_STYLE,
        interactive: false,
        attributionControl: false,
        pitchWithRotate: false,
        dragRotate: false,
        touchPitch: false,
        fadeDuration: 0,
        preserveDrawingBuffer: true
      });

      this.referenceOverlayMap.on('load', () => {
        if (!this.referenceOverlayMap.getSource(TERRAIN_SOURCE_ID)) {
          this.referenceOverlayMap.addSource(TERRAIN_SOURCE_ID, {
            type: 'raster-dem',
            url: TERRAIN_SOURCE_URL
          });
        }
        this.referenceOverlayMap.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });

        // The map texture is usable as soon as the style is loaded. Terrain is
        // allowed to refine independently instead of blocking the entire 3D map.
        this.referenceOverlayReady = true;
        this.syncReferenceOverlay();

        this.referenceOverlayMap.on('sourcedata', event => {
          if (event.sourceId !== TERRAIN_SOURCE_ID) return;
          this.syncReferenceOverlay();
        });
      });
    }

    syncReferenceOverlay() {
      if (!this.referenceOverlayMap || !this.referenceOverlayReady || !this.location) return;
      const visualZoom = this.zoomForRange();
      this.referenceOverlayMap.resize();
      this.referenceOverlayMap.jumpTo({
        center: [this.location.longitude, this.location.latitude],
        zoom: Math.max(0, visualZoom - 1),
        bearing: 0,
        pitch: 0
      });
    }

    renderMap() {
      super.renderMap();
      this.syncReferenceOverlay();
    }
  }

  window.ScannerCore.RadarView = ReferenceOverlayRadarView;
})();
