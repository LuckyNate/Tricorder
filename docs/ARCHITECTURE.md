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
- Wi-Fi Direct, media-route/Cast, mDNS and SSDP/UPnP discovery;
- future Wi-Fi RTT/UWB where supported;
- future camera/AR support;
- additional Android sensor inputs.

The native presentation loop runs on a 33 ms cadence. It consumes the latest hardware state; Wi-Fi scan attempts are scheduled separately, and Android/hardware may deliver new measurements more slowly than 30 Hz. Unchanged Bluetooth and network snapshots are not re-sent to the WebView.

### WebView responsibilities

The local HTML/CSS/JavaScript layer owns:

- application UI;
- custom OpenStreetMap tile radar presentation;
- generated sensor layer controls;
- persistent target registries;
- uncertainty-cloud rendering;
- confidence-based opacity and z-order;
- 2D / 3D mode presentation;
- the current best estimate for every visible target.

## Spatial model

The phone is the observer and radar center, not a target location.

- Range options are 20 m, 50 m, 100 m, 500 m and 1 km radius.
- Default range is 20 m.
- Phone heading rotates the map beneath the observer so forward remains up.
- World targets remain fixed in world coordinates as the view rotates.
- Target position is represented as a distribution/uncertainty region until evidence supports a tighter estimate.

## Sensor registry

Active Web sensors derive from `Sensor` and register into one runtime sensor registry.

A sensor owns its display identity, color, enabled state and frame behavior. The control pane is generated from that registry.

Current registered sensor layers:

- Wi-Fi source — green (`#39D353`);
- Bluetooth device — Bluetooth blue (`#0082FC`).
- network/Cast discovery — amber (`#FFD166`).

## Observation flow

1. Native Android acquires or refreshes a source observation.
2. The current scanner frame forwards the newest available state to the WebView.
3. The receiving sensor ingests the observation into a persistent target keyed by stable identity.
4. New evidence updates the target's observation history.
5. The target solver computes the current uncertainty region/confidence.
6. Changed sensor snapshots redraw target layers; existing map tiles are reused across position updates.
7. Layers are ordered by confidence.

The UI is therefore a live projection of target state, not a collection of disconnected detections.

## Wi-Fi localization

Each Wi-Fi access point is keyed by BSSID.

Observations include BSSID, SSID, RSSI, frequency, hardware timestamp, phone latitude/longitude/accuracy and matched heading metadata.

The native scanner attempts a Wi-Fi scan no more often than every 30 seconds and reads results at startup and when Android reports a scan. Cached results keep their real hardware timestamps; the WebView deduplicates observations rather than pretending cached scans are new samples. Sample age is displayed separately from the UI frame rate.

RSSI becomes approximate radial range evidence. With insufficient geometry, the target is a broad annulus: the router is somewhere in that cloud, not at the phone. With movement and/or sufficient orientation sweep, candidate world positions are scored from the observation history; the current UI renders the best candidate with a circular uncertainty spread, not the full candidate distribution.

Rotation evidence uses only true orientation heading, not GPS motion bearing, because it is being used as a weak antenna-direction clue rather than merely map facing.

## Bluetooth discovery and localization

The Bluetooth native source merges all currently implemented Android-visible Bluetooth data into one target stream:

- BLE advertisements from `BluetoothLeScanner` in low-latency mode;
- classic Bluetooth devices from `BluetoothAdapter.startDiscovery()` / `ACTION_FOUND`;
- bonded devices from `BluetoothAdapter.bondedDevices`.

Classic discovery is kept active while Tricorder is running and restarted after Android reports a completed discovery cycle.

Targets are keyed by Bluetooth address. BLE/classic observations with RSSI participate in the same movement/heading uncertainty solver used by the Bluetooth layer. Bonded devices without live RSSI are still exposed to the world model as very low-confidence unresolved targets rather than being hidden.

Automotive Bluetooth devices are filtered before they enter the target stream using the Bluetooth car-audio device class and known automotive-name hints.

The WebView treats each changed native Bluetooth snapshot as the current set of visible/known Bluetooth targets. Active observations age out natively after 30 seconds; bonded-only targets remain geographically unresolved. A radio callback captures the current observer pose where available.

## Network discovery

Wi-Fi Direct peers, media routes, mDNS services and SSDP advertisements feed a separate network layer. They are listed without an invented world position. Network discovery does not itself establish that a service is in the room.

## Heading

Primary heading comes from Android's rotation-vector sensor. GPS movement bearing is the fallback only when orientation heading is unavailable.

Heading has one canonical meaning everywhere in Tricorder: **the horizontal direction the phone/rear camera is physically looking, expressed as true-north degrees clockwise from north**.

The native layer derives that heading from the rotation matrix in world coordinates rather than from `getOrientation().azimuth`. The rear-camera optical axis (`-Z`) is projected onto the Earth-horizontal plane and converted with `atan2(east, north)`. When the rear camera is aimed too vertically for that projection to provide a stable azimuth, the current screen-top (`+Y`) world direction is used as the fallback. Magnetic declination is applied exactly once in the native layer.

The WebView must treat heading as already canonical. The map rotates beneath the observer by `-heading`; JavaScript must not add device-orientation offsets, sign corrections, or 90/180 degree compensations. Pitch and roll are separate pose components and must never redefine heading.

Wi-Fi/Bluetooth observation records can carry matched heading metadata so a physical sweep of the phone may add weak directional evidence when RSSI changes with orientation.

## Updates

The app checks the GitHub `latest` release metadata for a higher `versionCode`, downloads the versioned APK through DownloadManager, and opens Android's system installer.

Update checks occur when the app resumes, with a short throttle to avoid redundant requests.

## 3D / AR development priority

The current goal is to make the 3D/AR mode the authoritative spatial presentation and bring it to a finished state before changing the 2D map.

3D should use the phone/camera as the observer origin, render the live rear-camera feed as the background, maintain world-space targets while the phone moves and rotates, and display full 3D uncertainty volumes at approximately 30 FPS. Localization quality is monotonic: new evidence may preserve or improve a target solution, but a worse sample must not enlarge or degrade an already-established best-known solution.

The 2D map is intentionally left unchanged while 3D is being perfected.

After the 3D world model and AR presentation are stable, the 2D map will be reworked as a literal top-down minimap projection of that same 3D target state. It should not maintain an independent localization model. The two modes will ultimately share the same target positions, uncertainty volumes, confidence/staleness state, observer origin, and sensor colors; only the projection differs.

## Extension rule

New discovery or sensor APIs feed the same observation/target pipeline.

A newly available source should add evidence to existing targets when identities can be reconciled. If identity cannot yet be reconciled, it may create an unresolved target. Lack of precise range or position is represented as broad uncertainty, never as artificial certainty and never as automatic exclusion.
