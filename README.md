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

The native Android layer will expose device capabilities to the WebView, including location, heading/orientation, Bluetooth, Wi-Fi, camera, ranging technologies, and other sensors available on the device.

See `docs/ARCHITECTURE.md` and `docs/TARGET_MODEL.md` for the current design.

## Current state

The repository currently contains the first local WebView shell and the agreed architecture documentation. Native Android sensor bridges are not yet implemented.
