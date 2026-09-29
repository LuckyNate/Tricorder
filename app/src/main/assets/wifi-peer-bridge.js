(() => {
  function install() {
    const tricorder = window.Tricorder;
    const types = window.WifiPeerSensors;
    if (!tricorder || !tricorder.engine || !types) return false;
    const sensor = tricorder.getSensor('wifi-peers') || tricorder.registerSensor(new types.WifiPeerSensor());
    tricorder.onWifiPeerFrame = frame => sensor.ingest(frame || {});
    tricorder.engine.refreshControls();
    return true;
  }

  if (!install()) window.setTimeout(install, 0);
})();
