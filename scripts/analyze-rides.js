import { readFileSync } from 'fs';
import pool from '../lib/db.js';
import { getRouteCompare } from '../queries/stations.js';

const rides = JSON.parse(readFileSync('./my_bike_data.json', 'utf8'));
console.log(`Loaded ${rides.length} rides. Fetching station IDs...`);

const uniqueNames = [...new Set(rides.flatMap(r => [r.startAddress, r.endAddress]))];
const { rows: stationRows } = await pool.query(
  'SELECT id, name FROM stations WHERE name = ANY($1)',
  [uniqueNames]
);
const stationMap = new Map(stationRows.map(r => [r.name, r.id]));
console.log(`Mapped ${stationMap.size}/${uniqueNames.length} station names.`);

// Group rides by route (exclude round-trips)
const routeMap = new Map();
for (const ride of rides) {
  if (ride.startAddress === ride.endAddress) continue;
  const key = `${ride.startAddress}|||${ride.endAddress}`;
  if (!routeMap.has(key)) {
    routeMap.set(key, { startAddress: ride.startAddress, endAddress: ride.endAddress, entries: [] });
  }
  routeMap.get(key).entries.push({ ride, comparison: null });
}

// Build comparison work list
let skippedNoStation = 0;
const workList = [];
for (const group of routeMap.values()) {
  const startId = stationMap.get(group.startAddress);
  const endId = stationMap.get(group.endAddress);
  if (!startId || !endId) {
    skippedNoStation += group.entries.length;
    continue;
  }
  for (const entry of group.entries) {
    workList.push({ entry, startId, endId });
  }
}

console.log(`Comparing ${workList.length} rides (${skippedNoStation} skipped — station not in DB)...`);

let compared = 0;
let skippedLowData = 0;
const BATCH = 20;
for (let i = 0; i < workList.length; i += BATCH) {
  await Promise.all(workList.slice(i, i + BATCH).map(async ({ entry, startId, endId }) => {
    const durationSec = Math.round(entry.ride.duration / 1000);
    try {
      const result = await getRouteCompare(pool, startId, endId, durationSec, null, 'alltime');
      if (result.count >= 5) {
        entry.comparison = result;
        compared++;
      } else {
        skippedLowData++;
      }
    } catch {
      skippedLowData++;
    }
  }));
  process.stdout.write(`  ${Math.min(i + BATCH, workList.length)}/${workList.length}\r`);
}
console.log(`Done. ${compared} compared, ${skippedLowData} skipped (< 5 DB trips on route).\n`);

// ── Helpers ──

function fmtDate(msStr) {
  return new Date(Number(msStr)).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: '2-digit',
  });
}

function fmtMin(ms) {
  return `${Math.round(ms / 60000)} min`;
}

function fmtPct(pct) {
  return pct < 50
    ? `beat ${(100 - pct).toFixed(0)}% of riders`
    : `${pct.toFixed(0)}% faster than you`;
}

function routeLabel(g) {
  return `${g.startAddress} → ${g.endAddress}`;
}

function printAttempts(entries, sortKey = 'date') {
  const sorted = [...entries].sort((a, b) => {
    if (sortKey === 'best') {
      return (a.comparison?.percentileRank ?? 999) - (b.comparison?.percentileRank ?? 999);
    }
    if (sortKey === 'worst') {
      return (b.comparison?.percentileRank ?? -1) - (a.comparison?.percentileRank ?? -1);
    }
    return Number(a.ride.startTimeMs) - Number(b.ride.startTimeMs);
  });
  for (const { ride, comparison } of sorted) {
    if (!comparison) continue;
    console.log(`   ${fmtDate(ride.startTimeMs)}  ${fmtMin(ride.duration)}  ${fmtPct(comparison.percentileRank)}`);
  }
}

// ── Output ──

console.log('=== YOUR BIKE RIDE ANALYSIS ===\n');
const totalSkipped = skippedNoStation + skippedLowData;
console.log(`${rides.length} rides | ${routeMap.size} unique routes | ${compared} compared | ${totalSkipped} skipped\n`);

// Most popular routes (only routes with at least one compared ride)
const byPopularity = [...routeMap.values()]
  .filter(g => g.entries.some(e => e.comparison))
  .sort((a, b) => b.entries.length - a.entries.length)
  .slice(0, 10);

console.log('─── MOST POPULAR ROUTES ───');
byPopularity.forEach((g, i) => {
  const withData = g.entries.find(e => e.comparison);
  const dbNote = withData ? `  n=${withData.comparison.count} in DB` : '';
  console.log(`\n${i + 1}. ${routeLabel(g)}  (${g.entries.length} rides${dbNote})`);
  printAttempts(g.entries, 'date');
});

// Best routes
const routesWithData = [...routeMap.values()].filter(g => g.entries.some(e => e.comparison));

const byBest = routesWithData
  .map(g => ({
    g,
    best: Math.min(...g.entries.filter(e => e.comparison).map(e => e.comparison.percentileRank)),
  }))
  .sort((a, b) => a.best - b.best)
  .slice(0, 10);

console.log('\n─── BEST ROUTES  (you beat the most riders) ───');
byBest.forEach(({ g, best }, i) => {
  const dbCount = g.entries.find(e => e.comparison)?.comparison.count ?? 0;
  console.log(`\n${i + 1}. ${routeLabel(g)}  best: beat ${(100 - best).toFixed(0)}%  (${g.entries.length} rides, n=${dbCount})`);
  printAttempts(g.entries, 'best');
});

// Worst routes
const byWorst = routesWithData
  .map(g => ({
    g,
    worst: Math.max(...g.entries.filter(e => e.comparison).map(e => e.comparison.percentileRank)),
  }))
  .sort((a, b) => b.worst - a.worst)
  .slice(0, 10);

console.log('\n─── WORST ROUTES  (where you struggled most) ───');
byWorst.forEach(({ g, worst }, i) => {
  const dbCount = g.entries.find(e => e.comparison)?.comparison.count ?? 0;
  console.log(`\n${i + 1}. ${routeLabel(g)}  worst: ${worst.toFixed(0)}% faster than you  (${g.entries.length} rides, n=${dbCount})`);
  printAttempts(g.entries, 'worst');
});

await pool.end();
