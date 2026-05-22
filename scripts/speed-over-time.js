import pool from '../lib/db.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const outPath = join(dirname(fileURLToPath(import.meta.url)), '../speed-over-time.html');

console.log('Querying monthly average speeds across all trips (may take ~30s)…');

const { rows } = await pool.query(`
  WITH trip_speeds AS (
    SELECT
      DATE_TRUNC('month', started_at)::date AS month,
      -- Fast planar approximation valid for NYC (~111 320 m/° lat, ~83 000 m/° lng at 40.7 °N)
      SQRT(
        POWER((s2.lat - s1.lat) * 111320, 2) +
        POWER((s2.lng - s1.lng) * 83000,  2)
      ) / NULLIF(t.duration_seconds, 0) * 2.23694 AS speed_mph
    FROM trips t
    JOIN stations s1 ON s1.id = t.start_station_id
    JOIN stations s2 ON s2.id = t.end_station_id
    WHERE t.start_station_id != t.end_station_id
      AND t.duration_seconds BETWEEN 60 AND 7200
      AND s1.lat IS NOT NULL AND s2.lat IS NOT NULL
      AND DATE_TRUNC('month', t.started_at) > (SELECT DATE_TRUNC('month', MIN(started_at)) FROM trips)
  )
  SELECT
    month AS day,
    ROUND(AVG(speed_mph)::numeric, 3)   AS avg_speed_mph,
    COUNT(*)::int                       AS trip_count
  FROM trip_speeds
  WHERE speed_mph BETWEEN 1.25 AND 25
  GROUP BY month
  ORDER BY month
`);

await pool.end();
console.log(`${rows.length} monthly data points — writing HTML…`);

const json = JSON.stringify(rows);

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Citi Bike — Average Speed Over Time (mph)</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0c1016;
      color: #eef2ff;
      font-family: Inter, system-ui, sans-serif;
      font-size: 14px;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 40px 24px;
    }
    .page { width: 100%; max-width: 960px; }
    h1 { font-size: 22px; font-weight: 600; margin-bottom: 6px; }
    .subtitle { color: #566480; font-size: 13px; margin-bottom: 32px; }
    .stats {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 32px;
    }
    .stat {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 10px;
      padding: 14px 18px;
      min-width: 140px;
    }
    .stat .label { color: #566480; font-size: 12px; margin-bottom: 4px; }
    .stat .value { font-size: 20px; font-weight: 600; }
    .stat .value.up   { color: #4ade80; }
    .stat .value.down { color: #f87171; }
    .chart-wrap {
      background: #111827;
      border: 1px solid rgba(255,255,255,0.07);
      border-radius: 12px;
      padding: 24px;
      position: relative;
    }
    canvas { display: block; }
    .legend {
      display: flex;
      gap: 20px;
      margin-top: 16px;
      justify-content: center;
    }
    .legend-item { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #7a8faa; }
    .legend-swatch { width: 28px; height: 3px; border-radius: 2px; }
  </style>
</head>
<body>
<div class="page">
  <h1>Average Bike Speed Over Time</h1>
  <p class="subtitle" id="subtitle"></p>

  <div class="stats" id="stats"></div>

  <div class="chart-wrap">
    <canvas id="chart" height="420"></canvas>
    <div class="legend">
      <div class="legend-item">
        <div class="legend-swatch" style="background:rgba(147,197,253,0.6)"></div>
        Monthly average
      </div>
      <div class="legend-item">
        <div class="legend-swatch" style="background:#fbbf24"></div>
        Linear trend
      </div>
    </div>
  </div>
</div>

<script>
const rows = ${json};

// ── Helpers ──────────────────────────────────────────────────────────────────

function linReg(ys) {
  const n = ys.length;
  const xs = ys.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const ssXX = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  const ssXY = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const slope = ssXY / ssXX;
  const intercept = my - slope * mx;
  const predicted = xs.map(x => slope * x + intercept);
  const ssRes = ys.reduce((s, y, i) => s + (y - predicted[i]) ** 2, 0);
  const ssTot = ys.reduce((s, y) => s + (y - my) ** 2, 0);
  return { slope, intercept, r2: 1 - ssRes / ssTot, predicted };
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

function fmtSpeed(v) {
  return v.toFixed(2) + ' mph';
}

// ── Compute ───────────────────────────────────────────────────────────────────

const speeds = rows.map(r => +r.avg_speed_mph);
const labels = rows.map(r => r.day);
const { slope, intercept, r2, predicted } = linReg(speeds);

const slopePerYear = slope * 12;
const meanSpeed    = speeds.reduce((a, b) => a + b, 0) / speeds.length;
const totalChange  = predicted[predicted.length - 1] - predicted[0];
const up = totalChange >= 0;

// ── Header stats ──────────────────────────────────────────────────────────────

document.getElementById('subtitle').textContent =
  \`Monthly averages · \${fmtDate(labels[0])} – \${fmtDate(labels[labels.length - 1])} · straight-line distances\`;

const statsEl = document.getElementById('stats');
[
  { label: 'Mean speed',      value: fmtSpeed(meanSpeed),    cls: '' },
  { label: 'Trend per year',  value: (up ? '+' : '') + fmtSpeed(slopePerYear), cls: up ? 'up' : 'down' },
  { label: 'Total change',    value: (up ? '+' : '') + fmtSpeed(totalChange),  cls: up ? 'up' : 'down' },
  { label: 'R²',              value: r2.toFixed(4),           cls: '' },
  { label: 'Months',          value: rows.length.toLocaleString(), cls: '' },
  { label: 'Total trips',     value: rows.reduce((s, r) => s + r.trip_count, 0).toLocaleString(), cls: '' },
].forEach(({ label, value, cls }) => {
  statsEl.innerHTML += \`<div class="stat">
    <div class="label">\${label}</div>
    <div class="value \${cls}">\${value}</div>
  </div>\`;
});

// ── Chart ─────────────────────────────────────────────────────────────────────

// Build x-axis tick set (yearly)
const tickIndices = [];
let lastYear = null;
rows.forEach((r, i) => {
  const y = r.day.slice(0, 4); // "YYYY"
  if (y !== lastYear) { tickIndices.push(i); lastYear = y; }
});

Chart.defaults.color = '#566480';
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';

new Chart(document.getElementById('chart'), {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Monthly avg speed (km/h)',
        data: speeds,
        borderColor: 'rgba(147,197,253,0.7)',
        backgroundColor: 'rgba(147,197,253,0.15)',
        borderWidth: 2,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: 'rgba(147,197,253,0.9)',
        tension: 0.3,
        order: 2,
      },
      {
        label: 'Trend',
        data: predicted,
        borderColor: '#fbbf24',
        backgroundColor: 'transparent',
        borderWidth: 2.5,
        pointRadius: 0,
        tension: 0,
        order: 1,
      },
    ],
  },
  options: {
    responsive: true,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#1e2a3a',
        borderColor: 'rgba(255,255,255,0.08)',
        borderWidth: 1,
        callbacks: {
          title: ctx => fmtDate(labels[ctx[0].dataIndex]),
          label: ctx => {
            if (ctx.datasetIndex === 0) {
              const r = rows[ctx.dataIndex];
              return \` \${fmtSpeed(ctx.parsed.y)}  (\${r.trip_count.toLocaleString()} trips)\`;
            }
            return \` Trend: \${fmtSpeed(ctx.parsed.y)}\`;
          },
        },
      },
    },
    scales: {
      x: {
        ticks: {
          maxRotation: 0,
          autoSkip: false,
          callback: (_, i) => tickIndices.includes(i)
            ? new Date(labels[i]).toLocaleDateString('en-US', { year: 'numeric' })
            : null,
        },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
      y: {
        title: { display: true, text: 'mph', color: '#566480' },
        ticks: { callback: v => v + ' mph' },
        grid: { color: 'rgba(255,255,255,0.04)' },
        border: { color: 'rgba(255,255,255,0.08)' },
      },
    },
  },
});
</script>
</body>
</html>`;

writeFileSync(outPath, html, 'utf8');
console.log(`Written → speed-over-time.html`);
