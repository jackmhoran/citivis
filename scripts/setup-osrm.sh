#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/osrm-data"
mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

OSM_FILE="new-york-latest.osm.pbf"
OSM_URL="https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf"

if [ ! -f "$OSM_FILE" ]; then
  echo "Downloading NYC OSM data (~300 MB)…"
  curl -L -o "$OSM_FILE" "$OSM_URL"
else
  echo "OSM data already present, skipping download."
fi

echo "Preprocessing (extract)…"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-extract -p /opt/bicycle.lua /data/$OSM_FILE

echo "Preprocessing (partition)…"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-partition /data/new-york-latest.osrm

echo "Preprocessing (customize)…"
docker run --rm -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-customize /data/new-york-latest.osrm

echo "Starting OSRM server on http://localhost:5000 …"
docker run -d --name osrm-bike -p 5000:5000 -v "$DATA_DIR:/data" osrm/osrm-backend \
  osrm-routed --algorithm mld /data/new-york-latest.osrm

echo ""
echo "OSRM running. Use:"
echo "  OSRM_URL=http://localhost:5000 node scripts/build-station-distances.js"
echo ""
echo "When done:"
echo "  docker stop osrm-bike && docker rm osrm-bike"
