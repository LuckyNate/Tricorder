# Tricorder Architecture

## Core rule

Tricorder presents the **best current estimate from the most recent available data**.

The system does not hide an estimate merely because it is uncertain. Instead, uncertainty is represented visually and internally.

## Native shell + local WebView

Tricorder is designed as a native Android shell containing a local WebView application.

### Native Android responsibilities

The native layer is responsible for capabilities that require Android APIs or hardware access, including:

- device location;
- compass / orientation / motion sensors;
- Bluetooth and BLE scanning / advertising;
- Wi-Fi discovery and supported ranging facilities;
- UWB where available;
- camera and AR support;
- permission management;
- additional phone sensors exposed by Android.

Native observations are delivered to the WebView as normalized data events rather than forcing the Web UI to understand every Android API separately.

### WebView responsibilities

The local HTML/CSS/JavaScript layer owns:

- application UI;
- circular radar rendering;
- OpenStreetMap presentation;
- device marker and facing visualization;
- target visualization;
- target selection;
- target data/status display;
- confidence-based opacity and z-order;
- Radar / 3D View mode switching;
- presentation of the current best estimate.

## Spatial model

The phone is the live reference point.

- Current device position is the radar center.
- Current device heading defines facing.
- Default radar radius is 100 m.
- Range is a configurable parameter, not a hard-coded architectural assumption.
- Target positions are stored as estimated world positions where possible and projected into radar-relative coordinates for display.

OpenStreetMap supplies map geometry. The phone's own location and orientation sensors supply live tracking.

## Observation flow

1. A native or WebView source produces an observation.
2. The observation is associated with a target or creates a new target.
3. The target estimate is updated from the newest useful evidence.
4. Confidence and freshness are recomputed.
5. The renderer updates that target's existing layer.
6. Layers are ordered by confidence and rendered with confidence-driven opacity.

The UI therefore remains a live projection of current target state rather than a history of disconnected detections.

## Wi-Fi localization layer

Each Wi-Fi access point is a persistent target keyed by BSSID.

A Wi-Fi observation contains the current phone position and accuracy together with BSSID, SSID, RSSI, frequency, and timestamp.

The first implementation is deterministic. RSSI is converted into an approximate range, and candidate positions around the observation history are scored against all recent measurements. The output is a **2D probability field**, not a single router coordinate.

That field is rendered directly as a probability cloud:

- higher-probability regions are more opaque;
- lower-probability tails remain faint;
- each BSSID owns its own cloud layer;
- stronger overall target confidence raises that entire layer in the stack;
- new observations can shift, tighten, or broaden the cloud;
- multiple observations taken from different phone positions should cause overlapping likelihood regions to converge naturally.

The current implementation keeps a bounded recent observation history per BSSID and recomputes the cloud from that history. This provides a transparent baseline before adding more advanced ranging or learning systems.

## Modes

### Radar mode

Primary operating mode. Shows a circular local map around the user and the current target layers within the selected radius.

### 3D View

Uses the same target model and current estimates. The camera/AR presentation places the selected target estimate into the user's current field of view based on current location, heading, orientation, and any available ranging data.

The two modes do not maintain separate target truth.

## Extension rule

New sensor types should enter through the same observation/target pipeline. A new hardware source should improve the current estimate rather than require a new parallel UI architecture.
