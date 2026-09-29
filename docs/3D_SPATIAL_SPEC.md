# Tricorder 3D Spatial Specification

## Invariants

The 3D/AR view has one spatial model and one projection path.

- Observer origin: rear camera / phone position.
- World coordinates: local ENU meters: +X east, +Y north, +Z up.
- Orientation source: Android rotation-vector matrix.
- Camera orientation: derived directly from that matrix and current display rotation.
- True-north correction: geomagnetic declination is applied once to the matrix-derived world basis.
- Map geometry and detections use the same camera projection.
- The 2D DOM map is never tilted, scaled or rotated to simulate a 3D ground plane.
- CSS transforms are presentation only; they do not define spatial coordinates.

## Geographic position to local meters

For observer latitude `lat0`, longitude `lon0` and target latitude `lat`, longitude `lon`:

```
north = (lat - lat0) * 111320
east  = (lon - lon0) * 111320 * cos(meanLatitude)
up    = targetAltitude - observerAltitude
```

Angles are converted to radians for `cos`.

For map geometry without altitude, the AR map uses a horizontal plane below the camera by the configured camera-height estimate. That plane is world-horizontal because every map vertex has the same world `up` value.

## Android orientation matrix

`SensorManager.getRotationMatrixFromVector()` supplies the device-to-world rotation matrix. Android world axes are treated as east, magnetic north and up. Declination rotates the horizontal world basis to true north.

The rear-camera optical direction is device `-Z`. Display orientation only determines which device axis corresponds to screen-right and screen-up. No additional heading offsets, 90-degree corrections, sign hacks or CSS rotations are allowed in the 3D camera model.

The resulting camera basis is:

```
right   = world(screen-right device axis)
up      = world(screen-top device axis)
forward = world(device -Z)
```

## World to camera coordinates

For a world-space vector `v = (east, north, up)` relative to the phone:

```
cameraX = dot(v, right)
cameraY = dot(v, up)
cameraZ = dot(v, forward)
```

Points with `cameraZ <= nearPlane` are behind or too close to the camera and are not projected.

## Perspective projection

For viewport center `(cx, cy)` and focal lengths `(fx, fy)`:

```
screenX = cx + cameraX / cameraZ * fx
screenY = cy - cameraY / cameraZ * fy
```

The focal lengths are derived from the camera-view field of view and the actual displayed video aspect ratio, including `object-fit: cover` cropping.

Every 3D element uses this projection: detections, uncertainty volumes, horizon reference and AR map geometry.

## Uncertainty volumes

Horizontal and vertical target uncertainty remain world-space meter quantities. Their apparent screen radii are projected by angle:

```
radiusX = atan2(horizontalUncertainty, depth) * fx
radiusY = atan2(verticalUncertainty, depth) * fy
```

This preserves physical scaling with distance instead of using arbitrary pixel sizes.

## AR ground map

MapLibre is a geometry/data source only in 3D mode. Visible road/path/rail/water line coordinates are read from the loaded map sources, converted from latitude/longitude to local ENU meters, placed on the horizontal ground plane, and projected through the same camera model as detections.

The ordinary 2D map remains rendered offscreen/invisible while 3D is active so MapLibre can keep its source tiles available. It is not transformed into the camera view.

## Runtime structure

`world-space.js`
: Owns ENU world coordinates, device orientation basis and perspective/top-down projectors.

`spatial-engine.js`
: Owns the rebuilt AR camera view, target rendering, uncertainty projection and projected MapLibre ground geometry.

`map-reference-overlay.js`
: Keeps MapLibre source geometry synchronized with observer location/range.

`orientation-bridge.js`
: Delivers Android rotation matrix, display rotation, declination and gravity to the shared world pose.

The retired transform-stack files (`spatial-view.js`, `unified-spatial.js`, `horizon-hybrid.js`, `ar-ground-map.js`) remain in the repository for history but are not loaded by `index.html`.

## Failure-mode rule

Scale, heading, pitch, roll and map placement must never be corrected by editing one shared CSS transform string. A spatial bug is fixed in the coordinate or projection layer that owns that quantity. This prevents a scale correction from changing plane attitude, pivot or heading.
