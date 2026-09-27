# Tricorder Architecture

## Core rule

Tricorder presents the **best current estimate from the most recent available data**.

The system should use every useful observation Android exposes. Uncertainty is represented explicitly rather than used as a reason to hide data.

## Native shell + local WebView

Tricorder is a native Android shell containing a local WebView application.

### Native Android responsibilities

The native layer owns hardware/API acquisition and permission handling, including:

- GPS/network location;
- rotation-vector orientation and motion-bearing fallback;
- Wi-Fi scanning;
- Bluetooth Low Energy scanning;
- classic Bluetooth discovery;
- bonded Bluetooth enumeration;
- future Wi-Fi Direct, media-route/Cast, mDNS, SSDP/UPnP and other local discovery APIs;
- future Wi-Fi RTT/UWB where supported;
- future camera/AR support;
- additional Android sensor inputs.

The native scanner loop runs on a 33 ms cadence. Each sense is queried or its latest hardware state is consumed every frame. Android/hardware may update more slowly than 30 Hz; Tricorder still presents the newest available observation every frame rather than imposing an additional slow polling cadence.

### WebView responsibilities

The local HTML/CSS/JavaScript layer owns:

- application UI;
- Leaflet/OpenStreetMap radar presentation;
- generated sensor layer controls;
- persistent target registries;
- uncertainty-cloud rendering;
- confidence-based opacity and z-order;
- 2D / 3D mode presentation;
- the current best estimate for every visible target.

## Spatial model

The phone is the observer and radar center, not a target location.

- Range options are 10 m, 50 m, 100 m, 500 m and 1 km radius.
- Default range is 10 m.
- Phone heading rotates the map beneath the observer so forward remains up.
- World targets remain fixed in world coordinates as the view rotates.
- Target position is represented as a distribution/uncertainty region until evidence supports a tighter estimate.

## Sensor registry

Web sensors derive from `ScannerSensor` and register into one runtime sensor registry.

A sensor owns its display identity, color, enabled state and frame behavior. The control pane is generated from that registry.

Current registered sensor layers:

- Wi-Fi source — green (`#39D353`);
- Bluetooth device — Bluetooth blue (`#0082FC`).

## Observation flow

1. Native Android acquires or refreshes a source observation.
2. The current scanner frame forwards the newest available state to the WebView.
3. The receiving sensor ingests the observation into a persistent target keyed by stable identity.
4. New evidence updates the target's observation history.
5. The target solver computes the current uncertainty region/confidence.
6. Only dirty targets are redrawn.
7. Layers are ordered by confidence.

The UI is therefore a live projection of target state, not a collection of disconnected detections.

## Wi-Fi localization

Each Wi-Fi access point is keyed by BSSID.

Observations include BSSID, SSID, RSSI, frequency, hardware timestamp, phone latitude/longitude/accuracy and matched heading metadata.

The native scanner requests a Wi-Fi scan every scanner frame and also reads the current `WifiManager.scanResults` every frame. Cached results keep their real hardware timestamps; the WebView deduplicates observations rather than pretending cached scans are new samples.

RSSI becomes approximate radial range evidence. With insufficient geometry, the target is an annulus: the router is somewhere in that cloud, not at the phone. With movement and/or sufficient orientation sweep, candidate world positions are scored from the observation history and rendered as probability mass regions.

Rotation evidence uses only true orientation heading, not GPS motion bearing, because it is being used as a weak antenna-direction clue rather than merely map facing.

## Bluetooth discovery and localization

The Bluetooth native source merges all currently implemented Android-visible Bluetooth data into one target stream:

- BLE advertisements from `BluetoothLeScanner` in low-latency mode;
- classic Bluetooth devices from `BluetoothAdapter.startDiscovery()` / `ACTION_FOUND`;
- bonded devices from `BluetoothAdapter.bondedDevices`.

Classic discovery is kept active while Tricorder is running and restarted after Android reports a completed discovery cycle.

Targets are keyed by Bluetooth address. BLE/classic observations with RSSI participate in the same movement/heading uncertainty solver used by the Bluetooth layer. Bonded devices without live RSSI are still exposed to the world model as very low-confidence unresolved targets rather than being hidden.

Automotive Bluetooth devices are filtered before they enter the target stream using the Bluetooth car-audio device class and known automotive-name hints.

The WebView treats each native Bluetooth frame as the current set of visible/known Bluetooth targets. Non-bonded observations age out natively after 30 seconds; targets absent from the current native snapshot are removed from the Bluetooth layer.

## Heading

Primary heading comes from Android's rotation-vector sensor. GPS movement bearing is the fallback when orientation heading is unavailable.

Heading is smoothed before presentation. The map rotates under the phone while target coordinates stay in world space.

Wi-Fi/Bluetooth observation records can carry matched heading metadata so a physical sweep of the phone may add weak directional evidence when RSSI changes with orientation.

## Updates

The app checks the GitHub `latest` release metadata for a higher `versionCode`. The app does not download or install APKs itself.

Update checks occur when the app resumes, with a short throttle to avoid redundant requests.

## 3D / AR

The 3D view shares the same target truth as the 2D radar. Future camera/AR work should project the existing target estimates into the camera view rather than maintain a separate world model.

## Extension rule

New discovery or sensor APIs feed the same observation/target pipeline.

A newly available source should add evidence to existing targets when identities can be reconciled. If identity cannot yet be reconciled, it may create an unresolved target. Lack of precise range or position is represented as broad uncertainty, never as artificial certainty and never as automatic exclusion.
