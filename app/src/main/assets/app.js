const RANGE_METERS = 100;

const statusEl = document.getElementById('status');

const map = L.map('map', {
  zoomControl: false,
  attributionControl: false,
  dragging: false,
  doubleClickZoom: false,
  scrollWheelZoom: false,
  boxZoom: false,
  keyboard: false,
  tap: false,
  touchZoom: false
});

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20
}).addTo(map);

const deviceIcon = L.divIcon({
  className: '',
  html: '<div class="device-marker"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

let deviceMarker = null;
let accuracyRing = null;
let rangeRing = null;
let hasInitialFix = false;

function fitToRange(latlng) {
  const bounds = L.latLng(latlng.lat, latlng.lng).toBounds(RANGE_METERS * 2);
  map.fitBounds(bounds, { padding: [8, 8], animate: false });
}

function updateLocation(latitude, longitude, accuracy) {
  const latlng = L.latLng(latitude, longitude);

  if (!deviceMarker) {
    deviceMarker = L.marker(latlng, { icon: deviceIcon, interactive: false }).addTo(map);
    rangeRing = L.circle(latlng, {
      radius: RANGE_METERS,
      className: 'range-ring',
      interactive: false
    }).addTo(map);
    accuracyRing = L.circle(latlng, {
      radius: Math.max(1, accuracy || 1),
      className: 'accuracy-ring',
      interactive: false
    }).addTo(map);
  } else {
    deviceMarker.setLatLng(latlng);
    rangeRing.setLatLng(latlng);
    accuracyRing.setLatLng(latlng).setRadius(Math.max(1, accuracy || 1));
  }

  if (!hasInitialFix) {
    fitToRange(latlng);
    hasInitialFix = true;
  } else {
    map.panTo(latlng, { animate: true, duration: 0.35, noMoveStart: true });
  }

  statusEl.textContent = accuracy
    ? `±${Math.round(accuracy)} m`
    : 'Location active';
}

window.Tricorder = {
  onLocation(latitude, longitude, accuracy) {
    updateLocation(Number(latitude), Number(longitude), Number(accuracy));
  },
  onStatus(message) {
    statusEl.textContent = message;
  }
};
