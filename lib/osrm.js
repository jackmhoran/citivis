const BASE = (process.env.OSRM_URL ?? 'https://routing.openstreetmap.de/routed-bike').replace(/\/$/, '');

async function osrmGet(path, timeoutMs = 30_000) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  return res.json();
}

// Returns [[lng,lat], ...] or null
export async function fetchRouteGeometry(startLng, startLat, endLng, endLat) {
  const data = await osrmGet(
    `/route/v1/bike/${+startLng},${+startLat};${+endLng},${+endLat}?overview=full&geometries=geojson`
  );
  return data?.routes?.[0]?.geometry?.coordinates ?? null;
}

// Returns meters (integer) or null
export async function fetchRouteDistance(startLng, startLat, endLng, endLat) {
  const data = await osrmGet(
    `/route/v1/bike/${+startLng},${+startLat};${+endLng},${+endLat}?overview=false`
  );
  const dist = data?.routes?.[0]?.distance;
  return dist != null ? Math.round(dist) : null;
}

// Distance matrix for [{lng, lat}] array.
// Returns 2D array [sourceIdx][destIdx] → meters.
// Batches to stay within URL length limits (default batch: 100 coords).
export async function fetchDistanceTable(coords, batchSize = 100) {
  const n = coords.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(null));
  const totalCalls = Math.ceil(n / batchSize) ** 2;
  let call = 0;

  for (let si = 0; si < n; si += batchSize) {
    const srcSlice = coords.slice(si, si + batchSize);
    for (let di = 0; di < n; di += batchSize) {
      const dstSlice = coords.slice(di, di + batchSize);
      const all = [...srcSlice, ...dstSlice];
      const coordStr = all.map(c => `${+c.lng},${+c.lat}`).join(';');
      const sources  = srcSlice.map((_, i) => i).join(';');
      const dests    = dstSlice.map((_, i) => i + srcSlice.length).join(';');
      const data = await osrmGet(
        `/table/v1/bike/${coordStr}?sources=${sources}&destinations=${dests}&annotations=distance`,
        120_000
      );
      call++;
      process.stdout.write(`\r  call ${call}/${totalCalls} (${Math.round(call/totalCalls*100)}%)`);
      if (!data?.distances) continue;
      for (let r = 0; r < srcSlice.length; r++) {
        for (let c = 0; c < dstSlice.length; c++) {
          const dist = data.distances[r]?.[c];
          if (dist != null) matrix[si + r][di + c] = Math.round(dist);
        }
      }
    }
  }

  process.stdout.write('\n');
  return matrix;
}
