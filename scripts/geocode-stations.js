import pool from '../lib/db.js';

const NTA_URL = 'https://data.cityofnewyork.us/api/geospatial/cpf4-rkhq?method=export&type=GeoJSON';

function pointInRing(pt, ring) {
  const [px, py] = pt;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function classify(lng, lat, features) {
  const pt = [lng, lat];
  for (const f of features) {
    const { type, coordinates } = f.geometry;
    const polys = type === 'MultiPolygon' ? coordinates : [coordinates];
    for (const poly of polys) {
      if (pointInRing(pt, poly[0]))
        return { borough: f.properties.BoroName, neighborhood: f.properties.NTAName };
    }
  }
  return { borough: null, neighborhood: null };
}

console.log('Fetching NYC NTA boundaries…');
const res = await fetch(NTA_URL);
const { features } = await res.json();
console.log(`Loaded ${features.length} NTA polygons`);

const { rows: stations } = await pool.query(
  'SELECT id, lat, lng FROM stations WHERE lat IS NOT NULL AND lng IS NOT NULL'
);
console.log(`Classifying ${stations.length} stations…`);

let updated = 0;
for (const s of stations) {
  const { borough, neighborhood } = classify(+s.lng, +s.lat, features);
  if (borough) {
    await pool.query(
      'UPDATE stations SET borough=$1, neighborhood=$2 WHERE id=$3',
      [borough, neighborhood, s.id]
    );
    updated++;
  }
}

await pool.end();
console.log(`Done — ${updated}/${stations.length} stations geocoded.`);
