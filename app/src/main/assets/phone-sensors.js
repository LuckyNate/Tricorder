(() => {
  if (!window.ScannerCore) throw new Error('Phone sensors loaded before ScannerCore');
  const { Sensor } = window.ScannerCore;

  function formatNumber(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '—';
  }

  function vectorMagnitude(values) {
    if (!Array.isArray(values) || !values.length) return null;
    const valid = values.map(Number).filter(Number.isFinite);
    if (!valid.length) return null;
    return Math.sqrt(valid.reduce((sum, value) => sum + value * value, 0));
  }

  function sensorDetail(sample) {
    const values = Array.isArray(sample.values) ? sample.values : [];
    const unit = sample.unit || '';
    const type = Number(sample.type);
    if (type === 2 || type === 14) {
      const magnitude = vectorMagnitude(values);
      return `${formatNumber(magnitude)} ${unit} · X ${formatNumber(values[0])} · Y ${formatNumber(values[1])} · Z ${formatNumber(values[2])}`;
    }
    if (type === 1 || type === 10 || type === 9 || type === 16 || type === 4) {
      const magnitude = vectorMagnitude(values);
      return `${formatNumber(magnitude)} ${unit} · X ${formatNumber(values[0])} · Y ${formatNumber(values[1])} · Z ${formatNumber(values[2])}`;
    }
    if (type === 6) {
      const pressure = Number(values[0]);
      const altitude = Number.isFinite(pressure) && pressure > 0
        ? 44330 * (1 - Math.pow(pressure / 1013.25, 0.1903))
        : null;
      return `${formatNumber(pressure)} hPa · pressure altitude ${formatNumber(altitude)} m`;
    }
    if (type === 5) return `${formatNumber(values[0])} lux`;
    if (type === 8) return `${formatNumber(values[0])} cm`;
    if (type === 19) return `${formatNumber(values[0], 0)} steps`;
    return `${values.slice(0, 6).map(value => formatNumber(value)).join(' / ')}${unit ? ` ${unit}` : ''}`;
  }

  class HardwareSensor extends Sensor {
    constructor() {
      super({ id: 'hardware', label: 'DEVICE SENSORS', color: '#7FC8C2' });
      this.catalog = new Map();
    }

    ingestCatalog(rows) {
      if (!Array.isArray(rows)) return;
      rows.forEach(raw => {
        const id = String(raw.type);
        this.catalog.set(id, raw);
        const target = this.getOrCreateTarget(id, raw.typeName || raw.name || `Sensor ${id}`);
        target.kind = 'hardware-sensor';
        target.lastSeen = Date.now();
        target.lastReceivedAt = Date.now();
        target.detail = `${raw.name || ''}${raw.vendor ? ` · ${raw.vendor}` : ''}${raw.unit ? ` · ${raw.unit}` : ''}`;
        target.catalogOnly = true;
      });
      if (this.engine) {
        this.engine.needsRender = true;
        this.engine.refreshControls();
      }
    }

    ingestFrame(rows) {
      if (!Array.isArray(rows)) return;
      rows.forEach(raw => {
        const id = String(raw.type);
        const target = this.getOrCreateTarget(id, raw.typeName || raw.name || `Sensor ${id}`);
        target.kind = 'hardware-sensor';
        target.lastSeen = Date.now();
        target.lastReceivedAt = Date.now();
        target.sampleAgeMs = Number(raw.ageMs) || 0;
        target.detail = sensorDetail(raw);
        target.catalogOnly = false;
        target.raw = raw;
      });
      if (this.engine) this.engine.needsRender = true;
    }
  }

  class GnssSensor extends Sensor {
    constructor() {
      super({ id: 'gnss', label: 'GNSS', color: '#D7C56D' });
    }

    ingest(frame) {
      const payload = frame || {};
      const rows = Array.isArray(payload.satellites) ? payload.satellites : [];
      const seen = new Set();
      rows.forEach(raw => {
        const id = `${raw.constellation || 'GNSS'}:${raw.svid}`;
        seen.add(id);
        const target = this.getOrCreateTarget(id, `${raw.constellation || 'GNSS'} ${raw.svid}`);
        target.kind = 'satellite';
        target.detail = `${formatNumber(raw.cn0)} dB-Hz · az ${formatNumber(raw.azimuth, 0)}° · el ${formatNumber(raw.elevation, 0)}°${raw.usedInFix ? ' · FIX' : ''}`;
        target.lastSeen = Date.now();
        target.lastReceivedAt = Date.now();
        target.raw = raw;
      });
      [...this.targets.keys()].forEach(id => { if (!seen.has(id)) this.targets.delete(id); });
      this.summary = `${Number(payload.usedInFix) || 0}/${Number(payload.satelliteCount) || rows.length} used`;
      if (this.engine) this.engine.needsRender = true;
    }
  }

  class NfcSensor extends Sensor {
    constructor() {
      super({ id: 'nfc', label: 'NFC', color: '#C889D8' });
    }

    ingest(raw) {
      if (!raw) return;
      const id = String(raw.id || `tag-${Date.now()}`);
      const target = this.getOrCreateTarget(id, id ? `NFC ${id}` : 'NFC tag');
      target.kind = 'nfc-tag';
      target.detail = Array.isArray(raw.techList) ? raw.techList.join(' · ') : 'NFC tag';
      target.lastSeen = Number(raw.timestamp) || Date.now();
      target.lastReceivedAt = Date.now();
      target.raw = raw;
      if (this.engine) this.engine.needsRender = true;
    }
  }

  class AudioSensor extends Sensor {
    constructor() {
      super({ id: 'audio', label: 'AUDIO', color: '#D99A67' });
      this.context = null;
      this.analyser = null;
      this.stream = null;
      this.data = null;
      this.lastAnalysisAt = 0;
      this.started = false;
    }

    async start() {
      if (this.started || !navigator.mediaDevices?.getUserMedia) return;
      this.started = true;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return;
        this.context = new AudioContextClass();
        const source = this.context.createMediaStreamSource(this.stream);
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 2048;
        this.analyser.smoothingTimeConstant = 0.72;
        source.connect(this.analyser);
        this.data = new Uint8Array(this.analyser.frequencyBinCount);
      } catch (error) {
        this.started = false;
        console.warn('Audio sensor unavailable', error);
      }
    }

    frame(now) {
      if (!this.started) this.start();
      if (!this.analyser || !this.data || now - this.lastAnalysisAt < 100) return;
      this.lastAnalysisAt = now;
      this.analyser.getByteFrequencyData(this.data);
      let peakIndex = 0;
      let peakValue = 0;
      let energy = 0;
      for (let i = 0; i < this.data.length; i += 1) {
        const value = this.data[i];
        energy += value * value;
        if (value > peakValue) {
          peakValue = value;
          peakIndex = i;
        }
      }
      const rms = Math.sqrt(energy / Math.max(1, this.data.length)) / 255;
      const sampleRate = this.context?.sampleRate || 48000;
      const peakHz = peakIndex * sampleRate / (this.analyser.fftSize || 2048);
      const target = this.getOrCreateTarget('spectrum', 'Microphone spectrum');
      target.kind = 'audio-spectrum';
      target.detail = `peak ${formatNumber(peakHz, 0)} Hz · level ${formatNumber(rms * 100, 0)}%`;
      target.lastSeen = Date.now();
      target.lastReceivedAt = Date.now();
      target.raw = { peakHz, level: rms };
    }
  }

  class CameraSensor extends Sensor {
    constructor() {
      super({ id: 'camera-sense', label: 'CAMERA', color: '#8CB7E8' });
      this.video = document.getElementById('spatialCamera');
      this.canvas = document.createElement('canvas');
      this.canvas.width = 64;
      this.canvas.height = 36;
      this.context = this.canvas.getContext('2d', { willReadFrequently: true });
      this.previous = null;
      this.lastAnalysisAt = 0;
    }

    frame(now) {
      if (!this.video || !this.context || this.video.readyState < 2 || now - this.lastAnalysisAt < 150) return;
      this.lastAnalysisAt = now;
      try {
        this.context.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
        const pixels = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
        let luminance = 0;
        let motion = 0;
        const gray = new Uint8Array(this.canvas.width * this.canvas.height);
        for (let pixel = 0, index = 0; pixel < pixels.length; pixel += 4, index += 1) {
          const value = Math.round(0.2126 * pixels[pixel] + 0.7152 * pixels[pixel + 1] + 0.0722 * pixels[pixel + 2]);
          gray[index] = value;
          luminance += value;
          if (this.previous) motion += Math.abs(value - this.previous[index]);
        }
        this.previous = gray;
        const count = gray.length || 1;
        const target = this.getOrCreateTarget('optical', 'Optical field');
        target.kind = 'camera-analysis';
        target.detail = `brightness ${formatNumber(luminance / count / 255 * 100, 0)}% · motion ${formatNumber(motion / count / 255 * 100, 0)}%`;
        target.lastSeen = Date.now();
        target.lastReceivedAt = Date.now();
      } catch (_) {}
    }
  }

  function wifiChannel(frequency) {
    const mhz = Number(frequency);
    if (!Number.isFinite(mhz)) return null;
    if (mhz >= 2412 && mhz <= 2484) return mhz === 2484 ? 14 : Math.round((mhz - 2407) / 5);
    if (mhz >= 5000 && mhz <= 5900) return Math.round((mhz - 5000) / 5);
    if (mhz >= 5955 && mhz <= 7115) return Math.round((mhz - 5950) / 5);
    return null;
  }

  function wifiBand(frequency) {
    const mhz = Number(frequency);
    if (mhz >= 2400 && mhz < 2500) return '2.4 GHz';
    if (mhz >= 4900 && mhz < 5925) return '5 GHz';
    if (mhz >= 5925 && mhz < 7125) return '6 GHz';
    return `${formatNumber(mhz, 0)} MHz`;
  }

  function enrichWifi(sensor, rows) {
    if (!sensor || !Array.isArray(rows)) return;
    rows.forEach(raw => {
      const id = String(raw.bssid || '').toLowerCase();
      const target = sensor.targets.get(id);
      if (!target) return;
      const channel = wifiChannel(raw.frequency);
      const band = wifiBand(raw.frequency);
      target.detail = `${Number(raw.rssi) || 0} dBm · ${band}${channel ? ` ch ${channel}` : ''} · ${Number(raw.frequency) || 0} MHz`;
      target.radio = { frequency: Number(raw.frequency), channel, band };
    });
  }

  window.PhoneSensors = {
    HardwareSensor,
    GnssSensor,
    NfcSensor,
    AudioSensor,
    CameraSensor,
    enrichWifi
  };
})();
