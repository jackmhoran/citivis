#!/usr/bin/env node

import { parse } from 'csv-parse';
import unzipper from 'unzipper';
import { Pool } from 'pg';
import https from 'https';
import { Writable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { maintainRouteStats } from '../lib/maintain-route-stats.js';

const rawUrl = process.env.DATABASE_URL || 'postgresql://localhost/citivis';
const connectionString = rawUrl.replace(/([?&])sslmode=[^&?#]*/g, '$1').replace(/[?&]$/, '');
const S3_BASE = 'https://s3.amazonaws.com/tripdata';
const START_PERIOD = '2020-01';
const BATCH_SIZE = 5000;

const pool = new Pool({
  connectionString,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
});

// ── S3 key ↔ period mapping ───────────────────────────────────────────────────

// Maps one S3 key to zero or more { period, key } entries.
// Annual NYC keys (e.g. 2021-citibike-tripdata.zip) expand to 12 monthly periods.
function periodsFromKey(key) {
  let m;

  // Monthly NYC (2024+): 202401-citibike-tripdata.zip
  m = key.match(/^(\d{4})(\d{2})-citibike-tripdata\.zip$/i);
  if (m) return [{ period: `${m[1]}-${m[2]}`, key }];

  // Annual NYC (pre-2024): 2021-citibike-tripdata.zip → 2021-01 … 2021-12
  m = key.match(/^(\d{4})-citibike-tripdata\.zip$/i);
  if (m) {
    return Array.from({ length: 12 }, (_, i) => ({
      period: `${m[1]}-${String(i + 1).padStart(2, '0')}`,
      key,
    }));
  }

  // Monthly JC: JC-202101-citibike-tripdata.csv.zip or .zip
  // (bucket has a few typos — citbike, spaces — which we intentionally skip)
  m = key.match(/^JC-(\d{4})(\d{2})-citibike-tripdata(?:\.csv)?\.zip$/i);
  if (m) return [{ period: `JC-${m[1]}-${m[2]}`, key }];

  return [];
}

// Returns Map<period, s3key> for every period >= START_PERIOD on S3.
async function listRemoteEntries() {
  const xml = await new Promise((resolve, reject) => {
    https.get(`${S3_BASE}/?list-type=2&max-keys=1000`, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', reject);
    }).on('error', reject);
  });

  const entries = new Map();
  for (const [, key] of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    for (const { period, key: k } of periodsFromKey(key)) {
      const bare = period.startsWith('JC-') ? period.slice(3) : period;
      if (bare >= START_PERIOD) entries.set(period, k);
    }
  }
  return entries;
}

// ── Sync ──────────────────────────────────────────────────────────────────────

async function syncAll() {
  const [remoteEntries, { rows }] = await Promise.all([
    listRemoteEntries(),
    pool.query('SELECT month FROM ingestion_log'),
  ]);

  const done = new Set(rows.map(r => r.month));
  const missing = [...remoteEntries.entries()].filter(([p]) => !done.has(p));

  if (missing.length === 0) {
    console.log('Already up to date.');
    return;
  }

  console.log(`Remote: ${remoteEntries.size} periods. Ingested: ${done.size}. Missing: ${missing.length}.`);

  // Pre-2024 NYC months share an annual zip — group by key to download once per year.
  const annualKeys = new Map(); // s3key → [period, ...]
  const individualEntries = []; // [[period, key], ...]

  for (const [period, key] of missing) {
    if (!period.startsWith('JC-') && parseInt(period.slice(0, 4)) < 2024) {
      if (!annualKeys.has(key)) annualKeys.set(key, []);
      annualKeys.get(key).push(period);
    } else {
      individualEntries.push([period, key]);
    }
  }

  for (const [key] of annualKeys) {
    await ingestAnnualZip(key);
  }
  for (const [period, key] of individualEntries) {
    await ingestPeriod(period, key);
  }
}

// ── HTTP fetch ────────────────────────────────────────────────────────────────

function fetchStream(url, redirects = 10) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if ([301, 302, 307, 308].includes(res.statusCode)) {
        if (!redirects) { res.resume(); return reject(new Error('Too many redirects')); }
        res.resume();
        return fetchStream(res.headers.location, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}: ${url}`)); return; }

      const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
      let receivedBytes = 0;
      let lastPct = -1;

      const progress = new Transform({
        transform(chunk, _enc, cb) {
          receivedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.floor((receivedBytes / totalBytes) * 100);
            if (pct !== lastPct) {
              lastPct = pct;
              const mb = (receivedBytes / 1024 / 1024).toFixed(1);
              const total = (totalBytes / 1024 / 1024).toFixed(1);
              process.stdout.write(`  Downloading: ${mb} MB / ${total} MB (${pct}%)\r`);
            }
          } else {
            const mb = (receivedBytes / 1024 / 1024).toFixed(1);
            process.stdout.write(`  Downloading: ${mb} MB\r`);
          }
          cb(null, chunk);
        },
        flush(cb) { process.stdout.write('\n'); cb(); },
      });

      resolve(res.pipe(progress));
    }).on('error', reject);
  });
}

// ── Row parsing ───────────────────────────────────────────────────────────────

function parseRow(row) {
  const rideableType = (row['rideable_type'] || row['Rideable Type'] || '').toLowerCase().trim();
  // Legacy rows have no rideable_type — treat as classic. Modern rows must be classic_bike.
  if (rideableType && rideableType !== 'classic_bike') return null;

  // New format: started_at / ended_at
  // Legacy format: starttime / stoptime (lowercase, no space)
  const startedAt = new Date(row['started_at'] || row['Start Time'] || row['starttime']);
  const endedAt   = new Date(row['ended_at']   || row['Stop Time']  || row['stoptime']);
  if (isNaN(startedAt) || isNaN(endedAt)) return null;

  // New format has a UUID ride_id. Legacy format has bikeid (a bike number, not unique per trip).
  // Synthetic key: "legacy_<bikeid>_<ms>" is deterministic and unique per trip.
  let rideId = row['ride_id'] || row['Ride ID'];
  if (!rideId) {
    const bikeId = row['bikeid'];
    if (!bikeId) return null;
    rideId = `legacy_${bikeId}_${startedAt.getTime()}`;
  }

  return {
    ride_id:            String(rideId),
    started_at:         startedAt.toISOString(),
    duration_seconds:   Math.min(32767, Math.round((endedAt - startedAt) / 1000)),
    // New format uses camelCase; legacy format uses lowercase with spaces
    start_station_id:   row['start_station_id']   || row['Start Station ID']        || row['start station id']        || null,
    start_station_name: row['start_station_name'] || row['Start Station Name']      || row['start station name']      || null,
    start_lat:          row['start_lat']           || row['Start Station Latitude']  || row['start station latitude']  || null,
    start_lng:          row['start_lng']           || row['Start Station Longitude'] || row['start station longitude'] || null,
    end_station_id:     row['end_station_id']      || row['End Station ID']          || row['end station id']          || null,
    end_station_name:   row['end_station_name']    || row['End Station Name']        || row['end station name']        || null,
    end_lat:            row['end_lat']             || row['End Station Latitude']    || row['end station latitude']    || null,
    end_lng:            row['end_lng']             || row['End Station Longitude']   || row['end station longitude']   || null,
    is_member:          (() => { const v = row['member_casual'] || row['User Type'] || row['usertype']; return v ? ['member','Subscriber'].includes(v) : null; })(),
  };
}

// ── Batch insert ──────────────────────────────────────────────────────────────

async function upsertStations(stationMap) {
  if (!stationMap.size) return;
  const stations = [...stationMap.values()];
  const placeholders = [];
  const params = [];
  let i = 1;
  for (const s of stations) {
    placeholders.push(`($${i++},$${i++},$${i++},$${i++})`);
    params.push(s.id, s.name, parseFloat(s.lat) || null, parseFloat(s.lng) || null);
  }
  await pool.query(
    `INSERT INTO stations (id, name, lat, lng) VALUES ${placeholders.join(',')} ON CONFLICT (id) DO NOTHING`,
    params
  );
}

async function flushBatch(batch, affectedPairs) {
  const stationMap = new Map();
  for (const r of batch) {
    if (r.start_station_id && !stationMap.has(r.start_station_id)) {
      stationMap.set(r.start_station_id, {
        id: r.start_station_id, name: r.start_station_name,
        lat: r.start_lat, lng: r.start_lng,
      });
    }
    if (r.end_station_id && !stationMap.has(r.end_station_id)) {
      stationMap.set(r.end_station_id, {
        id: r.end_station_id, name: r.end_station_name,
        lat: r.end_lat, lng: r.end_lng,
      });
    }
  }
  await upsertStations(stationMap);

  const valid = batch.filter(r =>
    r.start_station_id &&
    r.end_station_id &&
    r.start_station_id !== r.end_station_id &&
    r.duration_seconds > 0
  );
  for (const r of valid) affectedPairs.add(`${r.start_station_id}|${r.end_station_id}`);
  if (!valid.length) return;

  const placeholders = [];
  const params = [];
  let i = 1;
  for (const r of valid) {
    placeholders.push(`($${i++},$${i++},$${i++},$${i++},$${i++},$${i++})`);
    params.push(r.ride_id, r.started_at, r.duration_seconds,
                r.start_station_id, r.end_station_id, r.is_member ?? null);
  }
  await pool.query(
    `INSERT INTO trips (ride_id, started_at, duration_seconds, start_station_id, end_station_id, is_member)
     VALUES ${placeholders.join(',')} ON CONFLICT (ride_id) DO NOTHING`,
    params
  );
}

async function processCsvStream(csvStream, tripCountRef, affectedPairs) {
  let batch = [];
  await new Promise((resolve, reject) => {
    const writer = new Writable({
      objectMode: true,
      write(row, _enc, cb) {
        const parsed = parseRow(row);
        if (parsed) batch.push(parsed);
        if (batch.length < BATCH_SIZE) return cb();

        const toFlush = batch.splice(0, BATCH_SIZE);
        flushBatch(toFlush, affectedPairs)
          .then(() => {
            tripCountRef.count += toFlush.length;
            if (tripCountRef.count % 50000 === 0)
              process.stdout.write(`  ${tripCountRef.count} rows...\r`);
            cb();
          })
          .catch(cb);
      },
      final(cb) {
        if (batch.length === 0) return cb();
        flushBatch(batch, affectedPairs)
          .then(() => { tripCountRef.count += batch.length; batch = []; cb(); })
          .catch(cb);
      },
    });
    pipeline(csvStream, writer).then(resolve).catch(reject);
  });
}

// ── Ingest functions ──────────────────────────────────────────────────────────

async function alreadyIngested(period) {
  const { rows } = await pool.query('SELECT 1 FROM ingestion_log WHERE month = $1', [period]);
  return rows.length > 0;
}

// Downloads an annual NYC zip (e.g. 2021-citibike-tripdata.zip), processes all
// CSVs inside it, and logs all 12 months. trip_count is 0 per month entry
// because splitting counts by month would require significant extra complexity;
// the total is printed to the console.
async function ingestAnnualZip(key) {
  const year = key.match(/^(\d{4})/)[1];
  const url = `${S3_BASE}/${key}`;
  console.log(`\nFetching ${url} (annual)…`);

  const httpStream = await fetchStream(url);
  const tripCountRef = { count: 0 };
  const affectedPairs = new Set();

  const zip = httpStream.pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of zip) {
    const name = entry.path.split('/').pop();
    // Skip macOS metadata artifacts (._* resource forks, .DS_Store)
    if (name.startsWith('._') || name === '.DS_Store' || name === '._.DS_Store') {
      entry.autodrain(); continue;
    }
    if (entry.path.match(/\.csv$/i)) {
      console.log(`  Processing ${entry.path}…`);
      const csvStream = entry.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
      await processCsvStream(csvStream, tripCountRef, affectedPairs);
    } else if (entry.path.match(/\.zip$/i)) {
      // Annual NYC zips contain nested monthly zips
      const innerZip = entry.pipe(unzipper.Parse({ forceStream: true }));
      for await (const inner of innerZip) {
        if (!inner.path.match(/\.csv$/i)) { inner.autodrain(); continue; }
        console.log(`  Processing ${inner.path}…`);
        const csvStream = inner.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
        await processCsvStream(csvStream, tripCountRef, affectedPairs);
      }
    } else {
      entry.autodrain();
    }
  }

  for (let m = 1; m <= 12; m++) {
    const period = `${year}-${String(m).padStart(2, '0')}`;
    await pool.query(
      `INSERT INTO ingestion_log (month, trip_count) VALUES ($1, $2) ON CONFLICT (month) DO NOTHING`,
      [period, 0]
    );
  }

  console.log(`\n${year}: ingested ${tripCountRef.count} classic bike trips.`);
  console.log(`Updating route_stats and trimming trips for ${affectedPairs.size} affected pairs…`);
  await maintainRouteStats(pool, affectedPairs);
}

async function ingestPeriod(period, key = null) {
  if (await alreadyIngested(period)) {
    console.log(`${period} already ingested, skipping.`);
    return;
  }

  if (!key) {
    const entries = await listRemoteEntries();
    key = entries.get(period);
    if (!key) throw new Error(`No S3 key found for period "${period}"`);
  }

  const url = `${S3_BASE}/${key}`;
  console.log(`\nFetching ${url}…`);
  const httpStream = await fetchStream(url);

  const tripCountRef = { count: 0 };
  const affectedPairs = new Set();

  const zip = httpStream.pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of zip) {
    if (!entry.path.match(/\.csv$/i)) { entry.autodrain(); continue; }
    console.log(`  Processing ${entry.path}…`);
    const csvStream = entry.pipe(parse({ columns: true, skip_empty_lines: true, trim: true }));
    await processCsvStream(csvStream, tripCountRef, affectedPairs);
  }

  await pool.query(
    `INSERT INTO ingestion_log (month, trip_count) VALUES ($1,$2)`,
    [period, tripCountRef.count]
  );
  console.log(`\n${period}: ingested ${tripCountRef.count} classic bike trips.`);
  console.log(`Updating route_stats and trimming trips for ${affectedPairs.size} affected pairs…`);
  await maintainRouteStats(pool, affectedPairs);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'sync') {
    await syncAll();
  } else if (cmd) {
    // Manual period ingestion: works for both NYC (2021-06) and JC (JC-2021-06).
    // Pre-2024 NYC periods trigger a full annual zip download.
    const entries = await listRemoteEntries();
    for (const period of [cmd, ...rest]) {
      const key = entries.get(period);
      if (!key) { console.error(`No S3 key found for "${period}"`); process.exit(1); }

      if (!period.startsWith('JC-') && parseInt(period.slice(0, 4)) < 2024) {
        await ingestAnnualZip(key);
      } else {
        await ingestPeriod(period, key);
      }
    }
  } else {
    console.error('Usage:');
    console.error('  npm run sync                    # fetch S3 listing, ingest all missing periods');
    console.error('  npm run ingest -- 2021-06       # ingest one NYC month (downloads full year zip)');
    console.error('  npm run ingest -- JC-2021-06   # ingest one JC month');
    process.exit(1);
  }

  await pool.end();
}

main().catch(err => { console.error(err.message); process.exit(1); });
