class NearbyNetworkSensor extends ScannerSensor {
  constructor() {
    super({
      id: 'network',
      label: 'NETWORK / CAST',
      color: '#FFD166',
      paneName: null,
      usesHeading: false
    });
    this.targets = new Map();
    this.listEl = null;
  }

  ensureList() {
    if (this.listEl) return this.listEl;
    const list = document.createElement('div');
    list.id = 'nearbyDeviceList';
    list.className = 'nearby-device-list';
    list.setAttribute('aria-label', 'Nearby network and cast devices');
    sensorControlsEl.insertAdjacentElement('afterend', list);
    this.listEl = list;
    return list;
  }

  onVisibilityChanged(visible) {
    const list = this.ensureList();
    list.hidden = !visible;
    if (visible) this.renderList();
  }

  ingest(observations) {
    if (!Array.isArray(observations)) return;
    const seen = new Set();

    observations.forEach(raw => {
      const id = String(raw.id || '').trim();
      if (!id) return;
      seen.add(id);
      this.targets.set(id, {
        id,
        name: String(raw.name || raw.kind || 'Nearby device'),
        source: String(raw.source || 'network'),
        kind: String(raw.kind || 'device'),
        detail: String(raw.detail || ''),
        timestamp: Number(raw.timestamp) || 0
      });
    });

    [...this.targets.keys()].forEach(id => {
      if (!seen.has(id)) this.targets.delete(id);
    });

    if (this.enabled) this.renderList();
  }

  renderList() {
    const list = this.ensureList();
    if (!this.enabled) {
      list.hidden = true;
      return;
    }

    list.hidden = false;
    list.replaceChildren();

    const targets = [...this.targets.values()].sort((a, b) =>
      a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
    );

    if (!targets.length) {
      const empty = document.createElement('div');
      empty.className = 'nearby-device-empty';
      empty.textContent = 'No network/cast devices detected yet';
      list.appendChild(empty);
      return;
    }

    targets.forEach(target => {
      const row = document.createElement('div');
      row.className = 'nearby-device-row';

      const name = document.createElement('span');
      name.className = 'nearby-device-name';
      name.textContent = target.name;

      const meta = document.createElement('span');
      meta.className = 'nearby-device-meta';
      meta.textContent = `${target.source} · ${target.kind}${target.detail ? ` · ${target.detail}` : ''}`;

      row.append(name, meta);
      list.appendChild(row);
    });
  }

  frame() {}
}

const nearbyNetworkSensor = window.Tricorder.registerSensor(new NearbyNetworkSensor());
nearbyNetworkSensor.renderList();
window.Tricorder.onNearbyNetworkScan = observations => nearbyNetworkSensor.ingest(observations);
