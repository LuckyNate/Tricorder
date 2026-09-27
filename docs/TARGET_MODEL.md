# Target Model

Every detected thing is represented as a target with one persistent visual layer.

## Target state

A target should be able to carry:

- stable internal ID;
- target type;
- optional display name;
- estimated latitude / longitude;
- optional estimated altitude;
- relative bearing;
- estimated distance;
- confidence;
- last observation time;
- observation sources;
- selected / unselected state;
- optional metadata specific to the source type.

## Layer rule

One target equals one visual layer.

New detections update the existing target layer rather than creating duplicate layers for every observation.

## Confidence presentation

Confidence controls visual prominence.

- Higher confidence -> higher opacity.
- Lower confidence -> greater transparency.
- Higher confidence -> higher render stack priority.
- Lower confidence -> lower render stack priority.

This makes the most strongly supported information naturally move to the foreground while weak or stale estimates remain visible behind it.

## Freshness

Recent evidence should contribute more strongly than stale evidence. Targets do not need to disappear immediately when a signal is lost; their confidence can decay so the estimate fades naturally until newer evidence replaces it or the target expires.

## Best-estimate rule

The displayed position is always the system's current best estimate from the latest useful evidence.

The UI does not require certainty before displaying a target. Uncertainty is communicated by the layer itself through opacity, stack position, and later potentially spatial spread or other visualization.

## Nearby Tricorder players

Other consenting Tricorder instances can be represented as ordinary targets. Local peer discovery can provide observations that feed the same target model as every other detectable source.

The initial design target for the nearby-player feature is the same local 100 m operating field used by the radar. Additional supported ranging or peer technologies can refine the estimate through the same observation pipeline.
