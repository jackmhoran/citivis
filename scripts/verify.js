#!/usr/bin/env node

import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://localhost/citivis' });

async function ingestionLog() {
  const { rows } = await pool.query(`
    SELECT month, trip_count, ingested_at
    FROM ingestion_log
    ORDER BY month
  `);
  console.log('\n=== Ingestion Log ===');
  if (!rows.length) { console.log('  (empty)'); return; }
  let total = 0;
  for (const r of rows) {
    console.log(`  ${r.month}  ${r.trip_count.toLocaleString()} trips  (ingested ${r.ingested_at.toISOString().slice(0,10)})`);
    total += r.trip_count;
  }
  console.log(`  TOTAL: ${total.toLocaleString()} trips across ${rows.length} period(s)`);
}

async function tripCounts() {
  const { rows } = await pool.query(`
    SELECT
      to_char(date_trunc('month', started_at), 'YYYY-MM') AS month,
      COUNT(*)                                              AS trips,
      COUNT(*) FILTER (WHERE member_casual = 'member')     AS members,
      COUNT(*) FILTER (WHERE member_casual = 'casual')     AS casuals
    FROM trips
    GROUP BY 1
    ORDER BY 1
  `);
  console.log('\n=== Trips by Month (from trips table) ===');
  if (!rows.length) { console.log('  (empty)'); return; }
  for (const r of rows) {
    console.log(`  ${r.month}  total=${Number(r.trips).toLocaleString()}  members=${Number(r.members).toLocaleString()}  casuals=${Number(r.casuals).toLocaleString()}`);
  }
}

async function durationStats() {
  const { rows } = await pool.query(`
    SELECT
      ROUND(AVG(duration_seconds)::numeric / 60.0, 1)    AS avg_min,
      ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_seconds))::numeric / 60.0, 1) AS median_min,
      ROUND(MIN(duration_seconds)::numeric / 60.0, 1)    AS min_min,
      ROUND(MAX(duration_seconds)::numeric / 60.0, 1)    AS max_min,
      COUNT(*) FILTER (WHERE duration_seconds <= 0) AS bad_duration
    FROM trips
  `);
  const r = rows[0];
  console.log('\n=== Duration Stats ===');
  console.log(`  avg: ${r.avg_min} min  median: ${r.median_min} min  min: ${r.min_min} min  max: ${r.max_min} min`);
  if (r.bad_duration > 0) console.log(`  WARNING: ${r.bad_duration} trips with duration <= 0`);
}

async function stationSummary() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE lat IS NULL OR lng IS NULL) AS missing_coords
    FROM stations
  `);
  const r = rows[0];
  console.log('\n=== Stations ===');
  console.log(`  total: ${Number(r.total).toLocaleString()}  missing coords: ${Number(r.missing_coords).toLocaleString()}`);
}

async function topRoutes() {
  const { rows } = await pool.query(`
    SELECT
      s.name  AS start_station,
      e.name  AS end_station,
      COUNT(*) AS trips
    FROM trips t
    JOIN stations s ON s.id = t.start_station_id
    JOIN stations e ON e.id = t.end_station_id
    WHERE t.start_station_id <> t.end_station_id
    GROUP BY 1, 2
    ORDER BY 3 DESC
    LIMIT 10
  `);
  console.log('\n=== Top 10 Routes ===');
  if (!rows.length) { console.log('  (empty)'); return; }
  for (const r of rows) {
    console.log(`  ${Number(r.trips).toLocaleString().padStart(6)}  ${r.start_station} → ${r.end_station}`);
  }
}

async function nullCheck() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*) FILTER (WHERE start_station_id IS NULL) AS no_start,
      COUNT(*) FILTER (WHERE end_station_id IS NULL)   AS no_end,
      COUNT(*) FILTER (WHERE member_casual IS NULL)    AS no_member_type
    FROM trips
  `);
  const r = rows[0];
  console.log('\n=== Null Check ===');
  console.log(`  no start station: ${Number(r.no_start).toLocaleString()}`);
  console.log(`  no end station:   ${Number(r.no_end).toLocaleString()}`);
  console.log(`  no member type:   ${Number(r.no_member_type).toLocaleString()}`);
}

async function main() {
  try {
    await ingestionLog();
    await tripCounts();
    await durationStats();
    await stationSummary();
    await topRoutes();
    await nullCheck();
    console.log('');
  } finally {
    await pool.end();
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
