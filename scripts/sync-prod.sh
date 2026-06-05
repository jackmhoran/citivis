#!/bin/bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL not set"
  echo "Usage: DATABASE_URL='postgres://...' ./scripts/sync-prod.sh"
  exit 1
fi

echo "==> Syncing new trip data..."
npm run sync

echo "==> Rebuilding explore pool..."
npm run build-explore-pool

echo "==> Applying distances to route_stats..."
npm run apply-distances

echo "==> Applying distances to explore_pool..."
npm run fetch-explore-distances

echo ""
echo "All done. Restart the server to go live."
