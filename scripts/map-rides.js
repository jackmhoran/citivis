import { readFileSync, writeFileSync } from 'fs';
import pool from '../lib/db.js';
import { fetchRouteGeometry } from '../lib/osrm.js';

const CACHE_PATH = './route-cache.json';
const OUT_PATH = './ride-map.html';
const DELAY_MS = 150;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Load & deduplicate (exclude round-trips)
const rides = JSON.parse(readFileSync('./my_bike_data.json', 'utf8'));
console.log(`Loaded ${rides.length} rides.`);

const routeMap = new Map();
for (const ride of rides) {
  if (ride.startAddress === ride.endAddress) continue;
  const key = `${ride.startAddress}|||${ride.endAddress}`;
  if (!routeMap.has(key)) {
    routeMap.set(key, { startAddress: ride.startAddress, endAddress: ride.endAddress, count: 0 });
  }
  routeMap.get(key).count++;
}
console.log(`${routeMap.size} unique routes.`);

// Station coordinates from DB
const uniqueNames = [...new Set([...routeMap.values()].flatMap(r => [r.startAddress, r.endAddress]))];
const { rows } = await pool.query(
  'SELECT name, lat, lng FROM stations WHERE name = ANY($1) AND lat IS NOT NULL AND lng IS NOT NULL',
  [uniqueNames]
);
await pool.end();

const coordMap = new Map(rows.map(r => [r.name, { lat: parseFloat(r.lat), lng: parseFloat(r.lng) }]));
console.log(`Coordinates for ${coordMap.size}/${uniqueNames.length} stations.`);

// Load cache
let cache = {};
try {
  cache = JSON.parse(readFileSync(CACHE_PATH, 'utf8'));
  console.log(`Cache: ${Object.keys(cache).length} routes loaded.`);
} catch {
  console.log('No cache — starting fresh.');
}

// Fetch uncached routes from OSRM
const toFetch = [...routeMap.keys()].filter(key => !cache[key]);
console.log(`Fetching ${toFetch.length} routes from OSRM...`);

let fetched = 0;
let failed = 0;
for (let i = 0; i < toFetch.length; i++) {
  const key = toFetch[i];
  const { startAddress, endAddress } = routeMap.get(key);
  const start = coordMap.get(startAddress);
  const end = coordMap.get(endAddress);

  if (!start || !end) { failed++; continue; }

  const coords = await fetchRouteGeometry(start.lng, start.lat, end.lng, end.lat);
  if (coords) {
    cache[key] = { type: 'LineString', coordinates: coords };
    fetched++;
  } else {
    failed++;
  }

  process.stdout.write(`  ${i + 1}/${toFetch.length}\r`);
  if (fetched % 25 === 0 && fetched > 0) writeFileSync(CACHE_PATH, JSON.stringify(cache));
  if (i < toFetch.length - 1) await sleep(DELAY_MS);
}

writeFileSync(CACHE_PATH, JSON.stringify(cache));
console.log(`\nFetched: ${fetched}  Failed/skipped: ${failed}`);

// Build route data
const routes = [];
for (const [key, { startAddress, endAddress, count }] of routeMap) {
  const geometry = cache[key];
  if (!geometry) continue;
  routes.push({ coords: geometry.coordinates, count, label: `${startAddress} → ${endAddress}` });
}
console.log(`${routes.length} routes ready for map.`);

// Generate HTML
const totalRides = routes.reduce((s, r) => s + r.count, 0);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>My Ride History</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0d1117; }
    #map { width: 100vw; height: 100vh; }
    .legend {
      background: rgba(13,17,23,0.88);
      color: #cdd6f4;
      padding: 12px 16px;
      border-radius: 8px;
      font: 13px/1.7 monospace;
      border: 1px solid rgba(255,255,255,0.08);
    }
    .swatch {
      display: inline-block;
      width: 20px; height: 4px;
      border-radius: 2px;
      margin-right: 6px;
      vertical-align: middle;
    }
  </style>
</head>
<body>
<div id="map"></div>
<script>
const ROUTES = ${JSON.stringify(routes)};

const map = L.map('map', { preferCanvas: true });

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 20,
}).addTo(map);

function routeColor(count) {
  if (count >= 5) return '#ff4a4a';
  if (count >= 2) return '#ff9f40';
  return '#4a9eff';
}

const bounds = [];

// Draw least-frequent routes first so popular ones render on top
const sorted = [...ROUTES].sort((a, b) => a.count - b.count);

for (const route of sorted) {
  // GeoJSON coords are [lng, lat]; Leaflet wants [lat, lng]
  const latlngs = route.coords.map(([lng, lat]) => [lat, lng]);
  L.polyline(latlngs, {
    color: routeColor(route.count),
    weight: Math.min(1 + Math.floor(route.count / 2), 7),
    opacity: 0.7,
  }).bindPopup(\`<b>\${route.label}</b><br>\${route.count} ride\${route.count !== 1 ? 's' : ''}\`).addTo(map);
  latlngs.forEach(ll => bounds.push(ll));
}

if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });

const legend = L.control({ position: 'bottomright' });
legend.onAdd = () => {
  const div = L.DomUtil.create('div', 'legend');
  div.innerHTML =
    '<b>My Ride History</b><br>' +
    '${routes.length} routes &middot; ${totalRides} rides<br><br>' +
    '<span class="swatch" style="background:#ff4a4a"></span>5+ rides<br>' +
    '<span class="swatch" style="background:#ff9f40"></span>2–4 rides<br>' +
    '<span class="swatch" style="background:#4a9eff"></span>1 ride';
  return div;
};
legend.addTo(map);
</script>
</body>
</html>`;

writeFileSync(OUT_PATH, html);
console.log(`Map written → ${OUT_PATH}`);
