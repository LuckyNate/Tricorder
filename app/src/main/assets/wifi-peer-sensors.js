(() => {
  if (!window.ScannerCore) throw new Error('Wi-Fi peer sensors loaded before ScannerCore');
  const { Sensor } = window.ScannerCore;

  class WifiPeerSensor extends Sensor {
    constructor() {
      super({ id: 'wifi-peers', label: 'WI-FI PEERS', color: '#7DB7C4' });
      this.capabilities = {};
    }

    ingest(frame = {}) {
      this.capabilities = {
        p2pSupported: Boolean(frame.p2pSupported),
        awareSupported: Boolean(frame.awareSupported),
        awareAvailable: Boolean(frame.awareAvailable),
        rttAvailable: Boolean(frame.rttAvailable),
        permission: Boolean(frame.permission)
      };

      const rows = [];
      (Array.isArray(frame.peers) ? frame.peers : []).forEach(raw => rows.push({ ...raw, source: 'Wi-Fi Direct' }));
      (Array.isArray(frame.services) ? frame.services : []).forEach(raw => rows.push({ ...raw, source: 'Wi-Fi Direct service', id: `service:${raw.id}` }));
      (Array.isArray(frame.aware) ? frame.aware : []).forEach(raw => rows.push({ ...raw, source: 'Wi-Fi Aware', id: `aware:${raw.id}` }));

      const seen = new Set();
      rows.forEach(raw => {
        const id = String(raw.id || '').trim();
        if (!id) return;
        seen.add(id);
        const target = this.getOrCreateTarget(id, String(raw.name || raw.deviceName || raw.source || 'Wi-Fi peer'));
        target.kind = String(raw.source || 'wifi-peer');
        target.lastSeen = Number(raw.timestamp) || Date.now();
        target.lastReceivedAt = Date.now();
        target.sampleAgeMs = Math.max(0, Date.now() - target.lastSeen);

        const detail = [];
        if (raw.deviceName && raw.deviceName !== target.name) detail.push(String(raw.deviceName));
        if (raw.status) detail.push(String(raw.status));
        if (raw.type) detail.push(String(raw.type));
        if (raw.primaryDeviceType) detail.push(String(raw.primaryDeviceType));
        if (raw.txt && typeof raw.txt === 'object' && Object.keys(raw.txt).length) detail.push(`${Object.keys(raw.txt).length} TXT fields`);

        const distance = Number(raw.distanceMeters);
        if (Number.isFinite(distance) && distance >= 0 && this.engine && this.engine.radar && this.engine.radar.location) {
          const center = this.engine.radar.location;
          const width = Math.max(1.5, distance * 0.15);
          target.position = { latitude: center.latitude, longitude: center.longitude };
          target.rangeRegion = {
            center: { latitude: center.latitude, longitude: center.longitude },
            innerMeters: Math.max(0, distance - width),
            outerMeters: distance + width
          };
          target.uncertaintyMeters = distance + width;
          target.confidence = 0.72;
          detail.unshift(`${distance.toFixed(distance < 10 ? 1 : 0)} m RTT`);
        } else {
          target.position = null;
          target.rangeRegion = null;
          target.uncertaintyMeters = 100;
          target.confidence = 0.15;
        }
        target.detail = detail.join(' · ') || String(raw.source || 'discoverable');
      });

      [...this.targets.keys()].forEach(id => {
        if (!seen.has(id)) this.targets.delete(id);
      });

      if (this.engine) {
        this.engine.needsRender = true;
        this.engine.refreshControls();
      }
    }
  }

  window.WifiPeerSensors = { WifiPeerSensor };
})();
