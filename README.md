# Tricorder

Tricorder is a local situational-awareness scanner built around one rule:

> Always show the best current estimate from the most recent available data.

If Android can expose useful information about the surrounding world, Tricorder should ingest it. Missing precision is represented as uncertainty, not used as a reason to hide a target.

## Current scanner behavior

The scanner runs as a continuously updated world model with a 30 FPS UI/render loop.

Current inputs:

- GPS/network location;
- rotation-vector phone heading with motion-bearing fallback;
- Wi-Fi scans;
- Bluetooth Low Energy advertisements;
- classic Bluetooth discovery;
- bonded/paired Bluetooth devices exposed by Android.

Automotive Bluetooth devices are filtered from the Bluetooth target layer.

Current planned discovery sources include Wi-Fi Direct, Cast/media routes, mDNS, SSDP/UPnP, supported ranging APIs such as Wi-Fi RTT/UWB, camera/AR data, and any other useful local observations Android exposes.

## Radar

The default 2D view is a local Leaflet/OpenStreetMap radar centered on the phone.

- Range options: **10 m, 50 m, 100 m, 500 m, 1 km radius**.
- Default range: **10 m radius**.
- The phone remains the observer/map center, not a detected target.
- The map rotates under the phone using current heading so forward stays up.
- Sensor layers can be toggled independently from the generated sensor-control key.
- Wi-Fi targets render green.
- Bluetooth targets render Bluetooth blue.
- Confidence controls opacity and visual priority.
- Uncertain targets remain broad/faint instead of disappearing.

## Target localization

Wi-Fi and Bluetooth observations are stored per target and combined over time.

RSSI is treated as approximate range evidence. Movement provides geometric separation between observations. Rotation-vector heading can contribute weak directional evidence when signal strength changes during a sweep. The result is rendered as an uncertainty cloud rather than pretending the scanner knows an exact coordinate.

A target with no usable range measurement can still be shown as a broad low-confidence unresolved region. This is currently used for bonded Bluetooth devices that Android exposes without a live RSSI measurement.

## Bluetooth discovery

The Bluetooth layer currently merges three Android-visible sources into the same target registry:

- BLE advertisements;
- classic Bluetooth devices found during discovery;
- bonded/paired devices.

BLE and classic detections with RSSI are treated as nearby observations and can participate in ranging/localization. Bonded devices without current RSSI are retained as unresolved low-confidence targets until stronger evidence is available.

Classic discovery is kept active while the scanner is running and restarted when Android reports that a discovery cycle has finished. BLE uses low-latency scanning. The scanner frame consumes the latest available observations rather than imposing a slower application polling interval.

## UI

Portrait:

- top half: scanner/radar;
- bottom half: status, range, sensor layer controls, and 2D/3D toggle.

Landscape:

- left: scanner/radar;
- right: controls/status.

The 3D side currently exists as the future camera/AR presentation mode and shares the same target truth as 2D.

## Architecture

Tricorder uses a native Android shell containing a local WebView UI.

Native Android owns hardware/API acquisition and permission handling. The WebView owns the sensor registry, target estimation, map rendering, confidence clouds, layer controls, and mode presentation.

See `docs/ARCHITECTURE.md` and `docs/TARGET_MODEL.md`.

## Updates and builds

GitHub Actions builds on pushes to `main` and publishes the rolling `latest` release.

Versioning uses the Actions run number:

- `versionCode = GITHUB_RUN_NUMBER`
- `versionName = 0.1.<GITHUB_RUN_NUMBER>`
- rolling APK: `Tricorder-latest.apk`

Main builds use the persistent release signing key configured in GitHub Actions. The app no longer downloads or installs APKs itself. It checks the GitHub `latest` release metadata and reports when a newer version is available. That check runs again when the app resumes, with a short throttle to avoid repeatedly hitting GitHub.
