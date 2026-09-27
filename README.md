# Tricorder

Tricorder is a local situational-awareness app built around a simple rule:

> Always show the best current estimate from the most recent available data.

The app combines phone location, facing/orientation, nearby-device observations, sensor data, and later AR/camera data into one continuously updated local picture.

## Main operating modes

### Radar

The default view is a circular local radar centered on the phone.

- Default range: **100 m radius**.
- OpenStreetMap provides the map layer.
- The phone provides live position and facing.
- Detected targets are plotted relative to the phone.
- Each target owns its own visual layer.
- Confidence controls both opacity and layer priority: higher-confidence information is more opaque and rendered above lower-confidence information.
- Stale or contradictory information fades rather than disappearing immediately.

The range is parameterized so additional scales, including a possible **1 km radius**, can be added without changing the target model.

### 3D / AR

A mode toggle switches between Radar and 3D View.

3D View uses the same target state as Radar. It combines the phone's current position and facing with camera/AR rendering so the user can face a target and see its current estimated location in space.

## UI layout

Portrait:

- Top half: circular radar.
- Bottom half: target data, status, and the Radar / 3D View toggle.

Landscape:

- Left half: circular radar.
- Right half: target data, status, and mode toggle.

## Architecture

Tricorder uses a native Android shell with a local WebView UI.

The WebView owns:

- visual rendering;
- radar/map presentation;
- target layers;
- confidence-driven opacity and stacking;
- target/status presentation;
- mode switching.

The native Android layer exposes device capabilities to the WebView. The first implemented bridge is live location; heading/orientation, Bluetooth, Wi-Fi, camera, ranging technologies, and other available sensors follow the same pattern.

See `docs/ARCHITECTURE.md` and `docs/TARGET_MODEL.md` for the current design.

## Build and versioning

GitHub Actions builds a clean debug APK on every push to `main`, pull request to `main`, and manual workflow run.

Build versions are iterative and use the Actions run number:

- `versionCode = GITHUB_RUN_NUMBER`
- `versionName = 0.1.<GITHUB_RUN_NUMBER>`
- versioned artifact: `Tricorder-0.1.<run>.apk`
- rolling artifact: `Tricorder-latest.apk`

Main-branch builds update the GitHub `latest` release with both APK names.

The build workflow also bootstraps the Gradle 9.5.0 wrapper if it is missing and persists the generated wrapper files back to the repository. Subsequent CI and local builds use `./gradlew`.

## Current state

Milestone zero is implemented:

- native Android local-WebView shell;
- runtime coarse/fine location permission request;
- live GPS/network location updates;
- OpenStreetMap/Leaflet map;
- initial map framing around the phone at a 100 m radius;
- phone position marker and accuracy ring;
- automatic recentering as the phone moves;
- iterative APK build/version workflow;
- automatic latest-build release publishing.

The next systems can now build on this live spatial base.
