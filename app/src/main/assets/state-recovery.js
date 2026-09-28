(() => {
  if (!window.ScannerCore) return;

  const { Observation, ScannerEngine } = window.ScannerCore;

  function cloneJson(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  function serializeObservation(observation) {
    return {
      sensorId: observation.sensorId,
      targetId: observation.targetId,
      timestamp: observation.timestamp,
      latitude: observation.latitude,
      longitude: observation.longitude,
      accuracy: observation.accuracy,
      rssi: observation.rssi,
      heading: observation.heading,
      headingSource: observation.headingSource,
      headingAccuracy: observation.headingAccuracy,
      raw: cloneJson(observation.raw || {})
    };
  }

  function serializeTarget(target) {
    const properties = {};
    Object.keys(target).forEach(key => {
      if (key === 'sensor' || key === 'observations') return;
      try { properties[key] = cloneJson(target[key]); } catch (_) {}
    });
    return {
      properties,
      observations: target.observations.map(serializeObservation)
    };
  }

  ScannerEngine.prototype.exportRecoveryState = function exportRecoveryState() {
    return {
      radar: {
        rangeMeters: this.radar.rangeMeters,
        location: cloneJson(this.radar.location),
        heading: this.radar.heading
      },
      sensors: [...this.sensors.values()].map(sensor => ({
        id: sensor.id,
        enabled: sensor.enabled,
        targets: [...sensor.targets.values()].map(serializeTarget)
      }))
    };
  };

  ScannerEngine.prototype.importRecoveryState = function importRecoveryState(state) {
    if (!state || typeof state !== 'object') return false;

    if (state.radar && typeof state.radar === 'object') {
      const range = Number(state.radar.rangeMeters);
      if (Number.isFinite(range) && range > 0) this.radar.setRange(range);
      const location = state.radar.location;
      if (location && Number.isFinite(Number(location.latitude)) && Number.isFinite(Number(location.longitude))) {
        this.radar.setLocation(Number(location.latitude), Number(location.longitude), Number(location.accuracy) || 25);
      }
      if (Number.isFinite(Number(state.radar.heading))) this.radar.setHeading(Number(state.radar.heading));
    }

    if (Array.isArray(state.sensors)) {
      state.sensors.forEach(savedSensor => {
        const sensor = this.get(String(savedSensor && savedSensor.id || ''));
        if (!sensor) return;
        sensor.targets.clear();
        sensor.enabled = savedSensor.enabled !== false;

        if (!Array.isArray(savedSensor.targets)) return;
        savedSensor.targets.forEach(savedTarget => {
          const properties = savedTarget && savedTarget.properties;
          if (!properties || properties.id === undefined || properties.id === null) return;
          const target = sensor.getOrCreateTarget(String(properties.id), String(properties.name || properties.id));

          Object.keys(properties).forEach(key => {
            if (key === 'sensor' || key === 'observations') return;
            target[key] = cloneJson(properties[key]);
          });

          target.observations = [];
          if (Array.isArray(savedTarget.observations)) {
            savedTarget.observations.forEach(savedObservation => {
              const raw = Object.assign({}, savedObservation.raw || {}, {
                timestamp: savedObservation.timestamp,
                latitude: savedObservation.latitude,
                longitude: savedObservation.longitude,
                accuracy: savedObservation.accuracy,
                rssi: savedObservation.rssi,
                heading: savedObservation.heading,
                headingSource: savedObservation.headingSource,
                headingAccuracy: savedObservation.headingAccuracy
              });
              const observation = new Observation(sensor.id, target.id, raw);
              target.observations.push(observation);
            });
          }
        });
      });
    }

    this.needsRender = true;
    this.refreshControls();
    this.renderLists();
    return true;
  };
})();
