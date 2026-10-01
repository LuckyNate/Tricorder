(() => {
  if (!window.ScannerCore || !window.maplibregl) return;

  const BaseRadarView = window.ScannerCore.RadarView;
  const TERRAIN_SOURCE_ID = 'tricorder-terrain';
  const TERRAIN_SOURCE_URL = 'https://tiles.mapterhorn.com/tilejson.json';

  class TerrainReferenceRadarView extends BaseRadarView {
    constructor(...args) {
      super(...args);
      this.referenceOverlayMap = null;
      this.referenceOverlayReady = false;
      this.initTerrainReference();
    }

    initTerrainReference() {
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      Object.assign(host.style, {
        position: 'fixed',
        left: '-2048px',
        top: '0',
        width: '512px',
        height: '512px',
        pointerEvents: 'none',
        visibility: 'hidden'
      });
      document.body.appendChild(host);

      this.referenceOverlayMap = new window.maplibregl.Map({
        container: host,
        style: {
          version: 8,
          sources: {},
          layers: []
        },
        interactive: false,
        attributionControl: false,
        fadeDuration: 0,
        preserveDrawingBuffer: false,
        center: [0, 0],
        zoom: 15
      });

      this.referenceOverlayMap.on('load', () => {
        if (!this.referenceOverlayMap.getSource(TERRAIN_SOURCE_ID)) {
          this.referenceOverlayMap.addSource(TERRAIN_SOURCE_ID, {
            type: 'raster-dem',
            url: TERRAIN_SOURCE_URL,
            tileSize: 256
          });
        }
        this.referenceOverlayMap.setTerrain({
          source: TERRAIN_SOURCE_ID,
          exaggeration: 1
        });
        this.referenceOverlayReady = true;
        this.syncReferenceOverlay();
      });

      this.referenceOverlayMap.on('sourcedata', event => {
        if (event.sourceId !== TERRAIN_SOURCE_ID) return;
        this.syncReferenceOverlay();
      });
    }

    syncReferenceOverlay() {
      if (!this.referenceOverlayMap || !this.referenceOverlayReady || !this.location) return;
      const zoom = Math.max(10, Math.min(18, this.zoomForRange() - 1));
      this.referenceOverlayMap.resize();
      this.referenceOverlayMap.jumpTo({
        center: [this.location.longitude, this.location.latitude],
        zoom,
        bearing: 0,
        pitch: 0,
        roll: 0
      });
      this.referenceOverlayMap.triggerRepaint();
    }

    renderMap() {
      super.renderMap();
      this.syncReferenceOverlay();
    }
  }

  window.ScannerCore.RadarView = TerrainReferenceRadarView;
})();
