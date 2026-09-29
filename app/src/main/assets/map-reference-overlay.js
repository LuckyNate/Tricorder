(() => {
  if (!window.ScannerCore || !window.maplibregl) return;

  const BaseRadarView = window.ScannerCore.RadarView;
  const REFERENCE_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const TERRAIN_SOURCE_ID = 'tricorder-terrain';
  const TERRAIN_SOURCE_URL = 'https://tiles.mapterhorn.com/tilejson.json';

  function layerKey(layer) {
    return `${layer.id || ''} ${layer['source-layer'] || ''}`.toLowerCase();
  }

  function keepReferenceLayer(layer) {
    const key = layerKey(layer);
    if (key.includes('building') || key.includes('housenumber') || key.includes('poi')) return false;

    if (layer.type === 'line') {
      return /(road|street|transport|highway|bridge|tunnel|boundary|path|rail)/.test(key);
    }

    if (layer.type === 'symbol') {
      return /(road|street|transport|highway)/.test(key);
    }

    return false;
  }

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
        fadeDuration: 0
      });

      this.referenceOverlayMap.on('load', () => {
        const style = this.referenceOverlayMap.getStyle();
        (style.layers || []).forEach(layer => {
          if (!keepReferenceLayer(layer)) {
            this.referenceOverlayMap.setLayoutProperty(layer.id, 'visibility', 'none');
            return;
          }

          if (layer.type === 'line') {
            this.referenceOverlayMap.setPaintProperty(layer.id, 'line-color', '#e8fff2');
            this.referenceOverlayMap.setPaintProperty(layer.id, 'line-opacity', 0.72);
          }

          if (layer.type === 'symbol') {
            try { this.referenceOverlayMap.setPaintProperty(layer.id, 'icon-opacity', 0); } catch (_) {}
            try { this.referenceOverlayMap.setPaintProperty(layer.id, 'text-color', '#ffffff'); } catch (_) {}
            try { this.referenceOverlayMap.setPaintProperty(layer.id, 'text-halo-color', '#07110d'); } catch (_) {}
            try { this.referenceOverlayMap.setPaintProperty(layer.id, 'text-halo-width', 1.5); } catch (_) {}
          }
        });

        if (!this.referenceOverlayMap.getSource(TERRAIN_SOURCE_ID)) {
          this.referenceOverlayMap.addSource(TERRAIN_SOURCE_ID, {
            type: 'raster-dem',
            url: TERRAIN_SOURCE_URL,
            tileSize: 256
          });
        }
        this.referenceOverlayMap.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });

        this.referenceOverlayReady = true;
        overlay.style.opacity = '1';
        this.syncReferenceOverlay();
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
