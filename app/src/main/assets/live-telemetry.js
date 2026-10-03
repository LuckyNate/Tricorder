(() => {
  const host = document.getElementById('liveTelemetry');
  const tricorder = window.Tricorder || (window.Tricorder = {});
  if (!host) return;

  let hardwareCatalog = [];
  let hardwareFrame = [];
  let gnssFrame = null;
  let wifiFrame = [];
  let bluetoothFrame = [];
  let nearbyNetworkFrame = [];
  let radioFrame = null;
  let nfcTag = null;
  const availability = new Map();

  const previous = {
    onWifiScan: tricorder.onWifiScan,
    onBluetoothScan: tricorder.onBluetoothScan,
    onRadioFrame: tricorder.onRadioFrame,
    onNearbyNetworkScan: tricorder.onNearbyNetworkScan,
    onHardwareSensorCatalog: tricorder.onHardwareSensorCatalog,
    onHardwareSensorFrame: tricorder.onHardwareSensorFrame,
    onGnssFrame: tricorder.onGnssFrame,
    onNfcTag: tricorder.onNfcTag,
    onSensorAvailability: tricorder.onSensorAvailability
  };

  function finite(value) {
    return Number.isFinite(Number(value));
  }

  function number(value, digits = 2) {
    return finite(value) ? Number(value).toFixed(digits) : '—';
  }

  function vector(values, unit) {
    if (!Array.isArray(values) || values.length === 0) return '—';
    const text = values.slice(0, 4).map(value => number(value, 2)).join(' ');
    return unit ? `${text} ${unit}` : text;
  }

  function rows(value) {
    return Array.isArray(value) ? value : [];
  }

  function compactSensorName(sensor) {
    return String(sensor.typeName || sensor.name || `SENSOR ${sensor.type || '?'}`)
      .replace('ACCELEROMETER UNCALIBRATED', 'ACCEL RAW')
      .replace('GYROSCOPE UNCALIBRATED', 'GYRO RAW')
      .replace('MAGNETIC FIELD UNCALIBRATED', 'MAG RAW')
      .replace('LINEAR ACCELERATION', 'LINEAR ACCEL')
      .replace('MAGNETIC FIELD', 'MAG FIELD')
      .replace('AMBIENT TEMPERATURE', 'TEMPERATURE')
      .replace('AMBIENT LIGHT', 'LIGHT');
  }

  function radioSummary(frame) {
    if (!frame || typeof frame !== 'object') return '';
    const parts = [];
    Object.entries(frame).forEach(([key, value]) => {
      if (value == null) return;
      if (Array.isArray(value)) parts.push(`${key} ${value.length}`);
      else if (typeof value !== 'object') parts.push(`${key} ${value}`);
    });
    return parts.slice(0, 6).join('  ');
  }

  function render() {
    const output = [];

    if (gnssFrame) {
      const sats = rows(gnssFrame.satellites);
      const used = finite(gnssFrame.usedInFix) ? Number(gnssFrame.usedInFix) : sats.filter(s => s && s.usedInFix).length;
      const count = finite(gnssFrame.satelliteCount) ? Number(gnssFrame.satelliteCount) : sats.length;
      output.push(`GNSS ${used}/${count} satellites used`);
      const strongest = sats
        .filter(s => s && finite(s.cn0))
        .sort((a, b) => Number(b.cn0) - Number(a.cn0))
        .slice(0, 6)
        .map(s => `${s.constellation || 'SAT'}-${s.svid} ${number(s.cn0, 1)}dB`)
        .join('  ');
      if (strongest) output.push(strongest);
    }

    rows(hardwareFrame).forEach(sensor => {
      if (!sensor) return;
      const age = finite(sensor.ageMs) ? ` ${Math.round(Number(sensor.ageMs))}ms` : '';
      output.push(`${compactSensorName(sensor)}  ${vector(sensor.values, sensor.unit)}${age}`);
    });

    if (wifiFrame.length) {
      const strongest = rows(wifiFrame)
        .filter(item => item && finite(item.rssi))
        .sort((a, b) => Number(b.rssi) - Number(a.rssi))[0];
      output.push(`WI-FI ${wifiFrame.length} visible${strongest ? `  strongest ${strongest.ssid || strongest.bssid || '?'} ${Math.round(Number(strongest.rssi))} dBm` : ''}`);
    }

    if (bluetoothFrame.length) output.push(`BLUETOOTH ${bluetoothFrame.length} visible`);
    if (nearbyNetworkFrame.length) output.push(`NETWORK ${nearbyNetworkFrame.length} nearby`);

    const radio = radioSummary(radioFrame);
    if (radio) output.push(`RADIO ${radio}`);

    if (nfcTag) {
      const techs = rows(nfcTag.techList).map(value => String(value).split('.').pop()).join(', ');
      output.push(`NFC ${nfcTag.id || 'tag'}${techs ? `  ${techs}` : ''}`);
    }

    availability.forEach((message, key) => {
      if (message) output.push(`${String(key).toUpperCase()} ${message}`);
    });

    if (!hardwareFrame.length && hardwareCatalog.length) {
      output.push(`SENSORS ${hardwareCatalog.length} available — waiting for live samples`);
    }

    host.textContent = output.join('\n');
  }

  tricorder.onHardwareSensorCatalog = value => {
    if (typeof previous.onHardwareSensorCatalog === 'function') previous.onHardwareSensorCatalog(value);
    hardwareCatalog = rows(value);
    render();
  };

  tricorder.onHardwareSensorFrame = value => {
    if (typeof previous.onHardwareSensorFrame === 'function') previous.onHardwareSensorFrame(value);
    hardwareFrame = rows(value);
    render();
  };

  tricorder.onGnssFrame = value => {
    if (typeof previous.onGnssFrame === 'function') previous.onGnssFrame(value);
    gnssFrame = value && typeof value === 'object' ? value : null;
    render();
  };

  tricorder.onWifiScan = value => {
    if (typeof previous.onWifiScan === 'function') previous.onWifiScan(value);
    wifiFrame = rows(value);
    render();
  };

  tricorder.onBluetoothScan = value => {
    if (typeof previous.onBluetoothScan === 'function') previous.onBluetoothScan(value);
    bluetoothFrame = rows(value);
    render();
  };

  tricorder.onNearbyNetworkScan = value => {
    if (typeof previous.onNearbyNetworkScan === 'function') previous.onNearbyNetworkScan(value);
    nearbyNetworkFrame = rows(value);
    render();
  };

  tricorder.onRadioFrame = value => {
    if (typeof previous.onRadioFrame === 'function') previous.onRadioFrame(value);
    radioFrame = value;
    render();
  };

  tricorder.onNfcTag = value => {
    if (typeof previous.onNfcTag === 'function') previous.onNfcTag(value);
    nfcTag = value && typeof value === 'object' ? value : null;
    render();
  };

  tricorder.onSensorAvailability = (sensor, message) => {
    if (typeof previous.onSensorAvailability === 'function') previous.onSensorAvailability(sensor, message);
    if (sensor) availability.set(String(sensor), String(message || ''));
    render();
  };
})();