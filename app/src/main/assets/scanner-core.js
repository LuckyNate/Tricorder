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
  }

  addObservation(observation) {
    this.observations.push(observation);
    if (this.observations.length > 32) this.observations.splice(0, this.observations.length - 32);
    this.lastSeen = Math.max(this.lastSeen, observation.timestamp);
  }
}

class Sensor {
  constructor({ id, label, color }) {
    this.id = id;
    this.label = label;
    this.color = color;
    this.enabled = true;
    this.targets = new Map();
    this.engine = null;
  }

  attach(engine) {
    this.engine = engine;
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.engine) this.engine.refreshControls();
  }

  toggle() {
    this.setEnabled(!this.enabled);
  }

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
    this.map = null;
    this.rangeRing = null;
    this.targetLayers = new Map();
    this.pingLayers = [];
    this.mapEl = document.getElementById('map');
    this.rotatorEl = document.getElementById('mapRotator');
    this.fallbackEl = document.getElementById('mapFallback');
    this.initMap();
  }

  initMap() {
    if (typeof L === 'undefined') {
      this.fallbackEl.hidden = false;
      this.fallbackEl.textContent = 'MAP ENGINE OFFLINE';
      return;
    }
    this.map = L.map(this.mapEl, {
      zoomControl: false,
      attributionControl: false,
      dragging: false,
      doubleClickZoom: false,
      scrollWheelZoom: false,
      boxZoom: false,
      keyboard: false,
      tap: false,
      touchZoom: false,
      zoomSnap: 0.01
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      updateWhenIdle: false,
      keepBuffer: 4
    }).addTo(this.map);
    this.map.setView([39.82, -75.42], 17);
  }

  setLocation(latitude, longitude, accuracy) {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    this.location = { latitude, longitude, accuracy: Number(accuracy) || 25 };
    if (this.map) {
      this.map.setView([latitude, longitude], this.map.getZoom(), { animate: false });
      this.updateRangeRing();
    }
  }

  setHeading(degrees) {
    if (!Number.isFinite(Number(degrees))) return;
    this.heading = Number(degrees);
    if (this.rotatorEl) {
      this.rotatorEl.style.transform = `rotate(${-this.heading}deg) scale(1.34)`;
    }
  }

  setRange(meters) {
    this.rangeMeters = meters;
    this.updateRangeRing();
  }

  updateRangeRing() {
    if (!this.map || !this.location) return;
    if (this.rangeRing) this.map.removeLayer(this.rangeRing);
    this.rangeRing = L.circle([this.location.latitude, this.location.longitude], {
      radius: this.rangeMeters,
      color: '#9fffd0',
      weight: 1,
      opacity: 0.8,
      fill: false,
      interactive: false
    }).addTo(this.map);
    const bounds = this.rangeRing.getBounds();
    this.map.fitBounds(bounds, { padding: [18, 18], animate: false, maxZoom: 20 });
  }

  clearTargetLayers() {
    if (!this.map) return;
    this.targetLayers.forEach(layer => this.map.removeLayer(layer));
    this.targetLayers.clear();
  }

  renderSensor(sensor) {
    if (!this.map || !sensor.enabled) return;
    sensor.targets.forEach(target => {
      if (!target.position) return;
      const key = `${sensor.id}:${target.id}`;
      const layers = [];
      const opacity = Math.max(0.12, Math.min(0.55, 0.12 + target.confidence * 0.43));
      const radius = Math.max(1.5, Number(target.uncertaintyMeters) || 1.5);
      layers.push(L.circle([target.position.latitude, target.position.longitude], {
        radius,
        stroke: true,
        color: sensor.color,
        weight: 1,
        opacity: Math.min(0.9, opacity + 0.2),
        fillColor: sensor.color,
        fillOpacity: opacity,
        interactive: false
      }));
      if (target.confidence >= 0.62) {
        layers.push(L.circleMarker([target.position.latitude, target.position.longitude], {
          radius: 4,
          stroke: false,
          fillColor: sensor.color,
          fillOpacity: 0.95,
          interactive: false
        }));
      }
      const group = L.layerGroup(layers).addTo(this.map);
      this.targetLayers.set(key, group);
    });
  }

  render(engine) {
    this.clearTargetLayers();
    engine.sensors.forEach(sensor => this.renderSensor(sensor));
  }

  ping(target) {
    if (!this.map || !target || !target.position) return;
    const center = [target.position.latitude, target.position.longitude];
    const color = target.sensor.color;
    const start = performance.now();
    const duration = 900;
    const maxRadius = Math.max(8, Math.min(45, (target.uncertaintyMeters || 12) * 0.8));
    const ring = L.circle(center, {
      radius: 1,
      color,
      weight: 3,
      opacity: 1,
      fill: false,
      interactive: false
    }).addTo(this.map);
    const animate = now => {
      const t = Math.min(1, (now - start) / duration);
      ring.setRadius(1 + maxRadius * t);
      ring.setStyle({ opacity: 1 - t, weight: 3 - 2 * t });
      if (t < 1) requestAnimationFrame(animate);
      else this.map.removeLayer(ring);
    };
    requestAnimationFrame(animate);
  }
}

class ScannerEngine {
  constructor(radar) {
    this.radar = radar;
    this.sensors = new Map();
    this.lastFrame = 0;
    this.controlsEl = document.getElementById('sensorControls');
    this.listsEl = document.getElementById('deviceLists');
    this.statusEl = document.getElementById('status');
    this.frame = this.frame.bind(this);
  }

  register(sensor) {
    sensor.attach(this);
    this.sensors.set(sensor.id, sensor);
    this.refreshControls();
    return sensor;
  }

  get(id) {
    return this.sensors.get(id) || null;
  }

  start() {
    requestAnimationFrame(this.frame);
  }

  frame(now) {
    if (now - this.lastFrame >= 1000 / 30) {
      this.sensors.forEach(sensor => sensor.frame(now));
      this.radar.render(this);
      this.renderLists();
      this.lastFrame = now;
    }
    requestAnimationFrame(this.frame);
  }

  refreshControls() {
    if (!this.controlsEl) return;
    this.controlsEl.replaceChildren();
    this.sensors.forEach(sensor => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `sensor-key${sensor.enabled ? '' : ' sensor-off'}`;
      button.style.setProperty('--sensor-color', sensor.color);
      button.innerHTML = `<span class="sensor-swatch"></span><span>${sensor.label}</span>`;
      button.addEventListener('click', () => sensor.toggle());
      this.controlsEl.appendChild(button);
    });
    this.renderLists();
  }

  renderLists() {
    if (!this.listsEl) return;
    this.listsEl.replaceChildren();
    this.sensors.forEach(sensor => {
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
          row.innerHTML = `<span class="device-name"></span><span class="device-meta"></span>`;
          row.querySelector('.device-name').textContent = target.name || target.id;
          row.querySelector('.device-meta').textContent = `${target.kind || sensor.id} · ±${meters}m · ${confidence}%${target.detail ? ` · ${target.detail}` : ''}`;
          row.addEventListener('click', () => this.radar.ping(target));
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
