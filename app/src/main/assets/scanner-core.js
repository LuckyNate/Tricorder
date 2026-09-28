class Observation {
  constructor(sensorId, targetId, raw = {}) {
    this.sensorId = sensorId;
    this.targetId = targetId;
    this.timestamp = Number(raw.timestamp) || Date.now();
    this.latitude = Number.isFinite(Number(raw.latitude)) ? Number(raw.latitude) : null;
    this.longitude = Number.isFinite(Number(raw.longitude)) ? Number(raw.longitude) : null;
    this.accuracy = Number(raw.accuracy) || 25;
    this.rssi = raw.rssi === null || raw.rssi === undefined ? null : Number(raw.rssi);
    this.heading = Number.isFinite(Number(raw.heading)) ? Number(raw.heading) : null;
    this.headingSource = String(raw.headingSource || 'none');
    this.headingAccuracy = Number(raw.headingAccuracy) || 0;
    this.raw = raw;
  }
}

class Target {
  constructor(sensor, id, name) {
    this.sensor = sensor;
    this.id = id;
    this.name = name || id;
    this.observations = [];
    this.position = null;
    this.uncertaintyMeters = 80;
    this.confidence = 0;
    this.detail = '';
    this.kind = '';
    this.lastSeen = 0;
    this.lastReceivedAt = 0;
    this.sampleAgeMs = 0;
    this.knowledgeOnly = false;
  }

  addObservation(observation) {
    this.observations.push(observation);
    if (this.observations.length > 32) this.observations.splice(0, this.observations.length - 32);
    this.lastSeen = Math.max(this.lastSeen, observation.timestamp);
  }
}

class Sensor {
  constructor({ id, label, color, showList = true }) {
    this.id = id;
    this.label = label;
    this.color = color;
    this.showList = showList;
    this.enabled = true;
    this.targets = new Map();
    this.engine = null;
  }

  attach(engine) { this.engine = engine; }
  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.engine) this.engine.refreshControls();
  }
  toggle() { this.setEnabled(!this.enabled); }
  getOrCreateTarget(id, name) {
    let target = this.targets.get(id);
    if (!target) {
      target = new Target(this, id, name);
      this.targets.set(id, target);
    }
    if (name) target.name = name;
    return target;
  }
  ingest() {}
  updateTarget() {}
  frame() {}
}

class RadarView {
  constructor() {
    this.rangeMeters = 20;
    this.location = null;
    this.heading = 0;
    this.zoom = 18;
    this.scale = 1;
    this.tileSize = 256;
    this.mapEl = document.getElementById('map');
    this.rotatorEl = document.getElementById('mapRotator');
    this.targetLayer = null;
    this.pingLayer = null;
    this.tileLayer = null;
    this.rangeRing = null;
    this.centerDot = null;
    this.resizeObserver = null;
    this.tiles = new Map();
    this.viewVersion = 0;
    this.initMap();
  }

  initMap() {
    if (!this.mapEl) throw new Error('Map element missing');
    this.mapEl.replaceChildren();
    this.mapEl.classList.add('local-map');

    this.tileLayer = document.createElement('div');
    this.tileLayer.className = 'tile-layer';
    this.targetLayer = document.createElement('div');
    this.targetLayer.className = 'target-layer';
    this.pingLayer = document.createElement('div');
    this.pingLayer.className = 'ping-layer';
    this.rangeRing = document.createElement('div');
    this.rangeRing.className = 'range-ring';
    this.centerDot = document.createElement('div');
    this.centerDot.className = 'map-center-dot';

    this.mapEl.append(this.tileLayer, this.targetLayer, this.pingLayer, this.rangeRing, this.centerDot);

    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.renderMap());
      this.resizeObserver.observe(this.mapEl);
    }
    this.renderMap();
  }

  lonToWorldX(lon, zoom) {
    return ((lon + 180) / 360) * this.tileSize * Math.pow(2, zoom);
  }

  latToWorldY(lat, zoom) {
    const clipped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const rad = clipped * Math.PI / 180;
    const merc = Math.log(Math.tan(Math.PI / 4 + rad / 2));
    return (1 - merc / Math.PI) / 2 * this.tileSize * Math.pow(2, zoom);
  }

  zoomForRange() {
    if (!this.location || !this.mapEl) return 18;
    const minDimension = Math.max(220, Math.min(this.mapEl.clientWidth || 320, this.mapEl.clientHeight || 320));
    const desiredMetersPerPixel = Math.max(0.05, this.rangeMeters / (minDimension * 0.36));
    const latitudeRadians = this.location.latitude * Math.PI / 180;
    const baseMetersPerPixel = 156543.03392 * Math.cos(latitudeRadians);
    return Math.max(3, Math.log2(baseMetersPerPixel / desiredMetersPerPixel));
  }

  metersPerPixel() {
    if (!this.location) return 1;
    return 156543.03392 * Math.cos(this.location.latitude * Math.PI / 180) / (Math.pow(2, this.zoom) * this.scale);
  }

  setLocation(latitude, longitude, accuracy) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    if (this.location && this.location.latitude === latitude && this.location.longitude === longitude && this.location.accuracy === accuracy) return;
    this.location = { latitude, longitude, accuracy: Number(accuracy) || 25 };
    this.viewVersion += 1;
    this.renderMap();
  }

  setHeading(degrees) {
    if (!Number.isFinite(Number(degrees))) return;
    this.heading = Number(degrees);
    if (this.rotatorEl) this.rotatorEl.style.transform = `rotate(${-this.heading}deg) scale(1.18)`;
  }

  setRange(meters) {
    this.rangeMeters = Number(meters) || 20;
    this.viewVersion += 1;
    this.renderMap();
  }

  renderMap() {
    if (!this.mapEl || !this.tileLayer || !this.rangeRing) return;
    const width = this.mapEl.clientWidth || 320;
    const height = this.mapEl.clientHeight || 320;

    if (!this.location) {
      this.tiles.forEach(tile => tile.remove());
      this.tiles.clear();
      this.rangeRing.style.width = '45%';
      this.rangeRing.style.height = '45%';
      this.rangeRing.style.left = '27.5%';
      this.rangeRing.style.top = '27.5%';
      return;
    }

    const visualZoom = this.zoomForRange();
    this.zoom = Math.max(3, Math.min(19, Math.floor(visualZoom)));
    this.scale = Math.pow(2, visualZoom - this.zoom);

    const centerX = this.lonToWorldX(this.location.longitude, this.zoom);
    const centerY = this.latToWorldY(this.location.latitude, this.zoom);
    const viewportWidthAtTileScale = width / this.scale;
    const viewportHeightAtTileScale = height / this.scale;
    const startX = Math.floor((centerX - viewportWidthAtTileScale / 2) / this.tileSize) - 1;
    const endX = Math.floor((centerX + viewportWidthAtTileScale / 2) / this.tileSize) + 1;
    const startY = Math.floor((centerY - viewportHeightAtTileScale / 2) / this.tileSize) - 1;
    const endY = Math.floor((centerY + viewportHeightAtTileScale / 2) / this.tileSize) + 1;
    const tileCount = Math.pow(2, this.zoom);
    const displayTileSize = this.tileSize * this.scale;

    const visibleTiles = new Set();
    for (let y = startY; y <= endY; y += 1) {
      if (y < 0 || y >= tileCount) continue;
      for (let x = startX; x <= endX; x += 1) {
        const wrappedX = ((x % tileCount) + tileCount) % tileCount;
        const key = `${this.zoom}/${x}/${y}`;
        visibleTiles.add(key);
        let img = this.tiles.get(key);
        if (!img) {
          img = document.createElement('img');
          img.className = 'map-tile';
          img.alt = '';
          img.draggable = false;
          img.src = `https://tile.openstreetmap.org/${this.zoom}/${wrappedX}/${y}.png`;
          this.tiles.set(key, img);
          this.tileLayer.appendChild(img);
        }
        img.style.width = `${displayTileSize}px`;
        img.style.height = `${displayTileSize}px`;
        img.style.left = `${(x * this.tileSize - centerX) * this.scale + width / 2}px`;
        img.style.top = `${(y * this.tileSize - centerY) * this.scale + height / 2}px`;
      }
    }
    this.tiles.forEach((img, key) => {
      if (!visibleTiles.has(key)) {
        img.remove();
        this.tiles.delete(key);
      }
    });

    const pixels = Math.max(8, this.rangeMeters / this.metersPerPixel());
    this.rangeRing.style.width = `${pixels * 2}px`;
    this.rangeRing.style.height = `${pixels * 2}px`;
    this.rangeRing.style.left = `${width / 2 - pixels}px`;
    this.rangeRing.style.top = `${height / 2 - pixels}px`;
  }

  project(position) {
    if (!this.location || !position || !this.mapEl) return null;
    const width = this.mapEl.clientWidth || 320;
    const height = this.mapEl.clientHeight || 320;
    const centerX = this.lonToWorldX(this.location.longitude, this.zoom);
    const centerY = this.latToWorldY(this.location.latitude, this.zoom);
    const x = (this.lonToWorldX(position.longitude, this.zoom) - centerX) * this.scale + width / 2;
    const y = (this.latToWorldY(position.latitude, this.zoom) - centerY) * this.scale + height / 2;
    return { x, y };
  }

  render(engine) {
    if (!this.targetLayer) return;
    this.targetLayer.replaceChildren();
    engine.sensors.forEach(sensor => {
      if (!sensor.enabled) return;
      sensor.targets.forEach(target => {
        if (!target.position) return;
        const point = this.project(target.position);
        if (!point) return;
        const radiusPx = Math.max(5, Math.min(140, (target.uncertaintyMeters || 5) / this.metersPerPixel()));
        const cloud = document.createElement('div');
        cloud.className = 'target-cloud';
        cloud.style.setProperty('--sensor-color', sensor.color);
        cloud.style.width = `${radiusPx * 2}px`;
        cloud.style.height = `${radiusPx * 2}px`;
        cloud.style.left = `${point.x - radiusPx}px`;
        cloud.style.top = `${point.y - radiusPx}px`;
        cloud.style.opacity = String(Math.max(0.16, Math.min(0.82, 0.2 + target.confidence * 0.62)));
        if (target.rangeRegion) {
          const inner = Math.max(0, Math.min(95, target.rangeRegion.innerMeters / target.rangeRegion.outerMeters * 100));
          cloud.style.background = `radial-gradient(circle, transparent ${inner}%, color-mix(in srgb, var(--sensor-color) 25%, transparent) ${Math.min(100, inner + 2)}%)`;
        }
        this.targetLayer.appendChild(cloud);

        if (target.confidence >= 0.62) {
          const dot = document.createElement('div');
          dot.className = 'target-dot';
          dot.style.setProperty('--sensor-color', sensor.color);
          dot.style.left = `${point.x - 4}px`;
          dot.style.top = `${point.y - 4}px`;
          this.targetLayer.appendChild(dot);
        }
      });
    });
  }

  ping(target) {
    if (!target || !target.position || !this.pingLayer) return false;
    const point = this.project(target.position);
    if (!point) return false;

    const ripple = document.createElement('div');
    ripple.className = 'target-ripple';
    ripple.style.setProperty('--sensor-color', target.sensor.color);
    ripple.style.left = `${point.x}px`;
    ripple.style.top = `${point.y}px`;

    for (let index = 0; index < 3; index += 1) {
      const ring = document.createElement('span');
      ring.className = 'target-ripple-ring';
      ring.style.animationDelay = `${index * 300}ms`;
      ripple.appendChild(ring);
    }

    this.pingLayer.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 3000);
    return true;
  }
}

class ScannerEngine {
  constructor(radar) {
    this.radar = radar;
    this.sensors = new Map();
    this.lastFrame = 0;
    this.lastListRender = 0;
    this.lastViewVersion = -1;
    this.needsRender = true;
    this.controlsEl = document.getElementById('sensorControls');
    this.listsEl = document.getElementById('deviceLists');
    this.statusEl = document.getElementById('status');
    this.frame = this.frame.bind(this);
  }

  register(sensor) {
    sensor.attach(engine);
    this.sensors.set(sensor.id, sensor);
    this.refreshControls();
    return sensor;
  }

  get(id) { return this.sensors.get(id) || null; }
  start() { requestAnimationFrame(this.frame); }

  frame(now) {
    if (now - this.lastFrame >= 1000 / 30) {
      this.sensors.forEach(sensor => sensor.frame(now));
      if (this.needsRender || this.lastViewVersion !== this.radar.viewVersion) {
        this.radar.render(this);
        this.lastViewVersion = this.radar.viewVersion;
        this.needsRender = false;
      }
      if (now - this.lastListRender >= 1000) {
        this.renderLists();
        this.lastListRender = now;
      }
      this.lastFrame = now;
    }
    requestAnimationFrame(this.frame);
  }

  refreshControls() {
    if (!this.controlsEl) return;
    this.controlsEl.replaceChildren();
    this.sensors.forEach(sensor => {
      if (sensor.id === 'heading') return;
      const fixed = sensor.id === 'network';
      const control = document.createElement(fixed ? 'div' : 'button');
      if (!fixed) control.type = 'button';
      control.className = fixed ? 'sensor-key sensor-fixed' : `sensor-key${sensor.enabled ? '' : ' sensor-off'}`;
      control.style.setProperty('--sensor-color', sensor.color);
      const swatch = document.createElement('span');
      swatch.className = 'sensor-swatch';
      const label = document.createElement('span');
      label.textContent = sensor.label;
      control.append(swatch, label);
      if (!fixed) control.addEventListener('click', () => sensor.toggle());
      this.controlsEl.appendChild(control);
    });
    this.renderLists();
  }

  renderLists() {
    if (!this.listsEl) return;
    this.listsEl.replaceChildren();
    this.sensors.forEach(sensor => {
      if (!sensor.showList) return;
      const section = document.createElement('section');
      section.className = 'device-section';
      section.style.setProperty('--sensor-color', sensor.color);
      const title = document.createElement('div');
      title.className = 'device-section-title';
      title.textContent = `${sensor.label} · ${sensor.targets.size}`;
      section.appendChild(title);

      const targets = [...sensor.targets.values()].sort((a, b) => b.lastSeen - a.lastSeen);
      if (!targets.length) {
        const empty = document.createElement('div');
        empty.className = 'device-empty';
        empty.textContent = 'NO DETECTIONS';
        section.appendChild(empty);
      } else {
        targets.forEach(target => {
          const row = document.createElement('button');
          row.type = 'button';
          row.className = 'device-row';
          const meters = Math.round(target.uncertaintyMeters || 0);
          const confidence = Math.round((target.confidence || 0) * 100);
          const name = document.createElement('span');
          name.className = 'device-name';
          name.textContent = target.name || target.id;
          const meta = document.createElement('span');
          meta.className = 'device-meta';
          const age = target.lastReceivedAt ? Math.max(0, Math.round((Date.now() - target.lastReceivedAt + (target.sampleAgeMs || 0)) / 1000)) : null;
          const freshness = target.knowledgeOnly ? 'paired; not heard'
            : sensor.id === 'network' ? (target.presenceKnown ? 'available route' : age === null ? 'age unknown' : `discovered ${age}s ago`)
            : age === null ? 'age unknown' : age < 5 ? 'heard now' : `last heard ${age}s ago`;
          const region = target.position ? `range spread ≈${meters}m · score ${confidence}/100` : 'location unresolved';
          meta.textContent = `${target.kind || sensor.id} · ${freshness} · ${region}${target.detail ? ` · ${target.detail}` : ''}`;
          row.append(name, meta);
          row.addEventListener('click', () => {
            if (!this.radar.ping(target)) this.setStatus(`${sensor.label}: location unresolved`);
          });
          section.appendChild(row);
        });
      }
      this.listsEl.appendChild(section);
    });
  }

  setStatus(text) {
    if (this.statusEl) this.statusEl.textContent = text;
  }
}

window.ScannerCore = { Observation, Target, Sensor, RadarView, ScannerEngine };
