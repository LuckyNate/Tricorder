# Target Model

Every detected thing is represented as a persistent target with one visual layer.

## Core rule

If Tricorder can observe something useful, it should enter the world model even when position or range is uncertain.

Uncertainty is represented as spatial spread, transparency, confidence and layer priority. Missing precision is not a reason to hide a target.

## Target state

A target can carry:

- stable internal ID;
- source identity such as BSSID or Bluetooth address;
- target/sensor type;
- optional display name;
- estimated latitude / longitude where available;
- optional altitude;
- relative bearing;
- estimated distance;
- confidence;
- last observation time;
- observation history;
- observation source(s);
- selected / unselected state;
- source-specific metadata.

## One target, one layer

New observations update an existing target whenever stable identity says they refer to the same thing.

The scanner does not create a new visual object for every sample.

## Uncertainty model

A target does not require a solved point location.

Possible presentations include:

- unresolved broad region when existence is known but range is not;
- annulus when one or more RSSI observations provide approximate radial range but insufficient geometry;
- probability field when movement and/or heading evidence supplies useful geometry;
- high-confidence point marker only when the solved distribution is concentrated enough.

The visual statement is always "the target is believed to be somewhere in this region," not "the phone is the target location."

## Confidence presentation

- Higher confidence -> higher opacity.
- Lower confidence -> greater transparency.
- Higher confidence -> higher render stack priority.
- Lower confidence -> lower render stack priority.
- Broader spatial spread communicates weaker positional certainty.

## Freshness

Recent observations contribute more strongly than stale observations.

A source may retain a target briefly after its last active observation if that is useful to the sensor model. The current Bluetooth native layer retains active BLE/classic observations for 30 seconds. Bonded Bluetooth devices are a different class of evidence: Android knows the relationship exists even when no current RSSI measurement is available, so they remain visible as unresolved low-confidence targets until stronger evidence appears.

## Wi-Fi targets

Wi-Fi targets are keyed by BSSID.

Observation history includes RSSI, frequency, true scan timestamp, observer position/accuracy and matched heading metadata. Cached Android scan results are deduplicated by their original timestamps rather than treated as new measurements.

Without sufficient geometry the target renders as a radial uncertainty cloud. Movement between observations and orientation sweeps can tighten the distribution.

## Bluetooth targets

Bluetooth targets are keyed by Bluetooth address and currently merge:

- BLE advertising observations;
- classic Bluetooth discovery observations;
- bonded/paired-device knowledge.

BLE/classic observations that include RSSI can be ranged approximately and accumulated over movement/rotation just like other radio observations.

Bonded observations may have no live RSSI. Those are deliberately kept as broad, very-low-confidence unresolved targets around the current observer region. A later BLE or classic observation of the same address upgrades the same target with actual nearby/range evidence instead of creating a duplicate target.

Automotive Bluetooth targets are filtered before target creation.

## Multi-source identity

As additional nearby-device discovery sources are implemented, the preferred behavior is to merge observations into an existing target when identity can be supported.

Examples of future evidence include Wi-Fi Direct identity, Cast/media routes, mDNS service identity, SSDP/UPnP identity, Wi-Fi RTT and UWB ranging.

When identity cannot be reconciled confidently, keep separate uncertain targets rather than inventing a merge.

## Nearby Tricorder players

Other consenting Tricorder instances can be ordinary targets. Peer discovery and any supported ranging source should feed the same target model instead of creating a special parallel positioning system.
