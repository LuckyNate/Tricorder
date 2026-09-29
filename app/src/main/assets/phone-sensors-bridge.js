(() => {
  function install() {
    const tricorder = window.Tricorder;
    const types = window.PhoneSensors;
    if (!tricorder || !tricorder.engine || !types) return false;

    const hardware = tricorder.getSensor('hardware') || tricorder.registerSensor(new types.HardwareSensor());
    const gnss = tricorder.getSensor('gnss') || tricorder.registerSensor(new types.GnssSensor());
    const nfc = tricorder.getSensor('nfc') || tricorder.registerSensor(new types.NfcSensor());
    const audio = tricorder.getSensor('audio') || tricorder.registerSensor(new types.AudioSensor());
    const cameraSense = tricorder.getSensor('camera-sense') || tricorder.registerSensor(new types.CameraSensor());

    tricorder.onHardwareSensorCatalog = rows => hardware.ingestCatalog(rows);
    tricorder.onHardwareSensorFrame = rows => hardware.ingestFrame(rows);
    tricorder.onGnssFrame = frame => gnss.ingest(frame);
    tricorder.onNfcTag = tag => nfc.ingest(tag);

    const originalWifi = tricorder.onWifiScan;
    if (typeof originalWifi === 'function') {
      tricorder.onWifiScan = function onWifiScan(rows) {
        originalWifi.call(tricorder, rows);
        types.enrichWifi(tricorder.getSensor('wifi'), rows);
      };
    }

    const originalBluetooth = tricorder.onBluetoothScan;
    if (typeof originalBluetooth === 'function') {
      tricorder.onBluetoothScan = function onBluetoothScan(rows) {
        originalBluetooth.call(tricorder, rows);
        const sensor = tricorder.getSensor('bluetooth');
        if (!sensor || !Array.isArray(rows)) return;
        rows.forEach(raw => {
          const id = String(raw.address || raw.id || '').toLowerCase();
          const target = sensor.targets.get(id);
          if (!target) return;
          const extras = [];
          if (raw.connectable !== undefined) extras.push(raw.connectable ? 'connectable' : 'non-connectable');
          if (Array.isArray(raw.serviceUuids) && raw.serviceUuids.length) extras.push(`${raw.serviceUuids.length} services`);
          if (raw.manufacturerData && typeof raw.manufacturerData === 'object') extras.push(`${Object.keys(raw.manufacturerData).length} mfr blocks`);
          if (raw.txPower !== undefined && raw.txPower !== null) extras.push(`tx ${raw.txPower} dBm`);
          if (extras.length) target.detail = `${target.detail}${target.detail ? ' · ' : ''}${extras.join(' · ')}`;
        });
      };
    }

    audio.start();
    tricorder.engine.refreshControls();
    return true;
  }

  if (!install()) window.setTimeout(install, 0);
})();
