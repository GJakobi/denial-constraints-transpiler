#!/usr/bin/env bash
# demo.sh
#
# End-to-end demo: starts PostgreSQL, loads a dataset and runs
# the pre-converted sound DCs against it.
#
# Requirements: Docker, Node.js >= 18, npm
#
# Usage:
#   ./scripts/demo.sh               # uses airport dataset (small, fast)
#   ./scripts/demo.sh tax500k       # uses tax500k (larger, ~15 000 rows)

set -euo pipefail

DATASET="${1:-airport}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DC_FILE="$ROOT/examples/dcs/${DATASET}.txt"
DATA_FILE="$ROOT/data/datasets/${DATASET}.csv"

# Fallback: Hospital has uppercase H
if [ ! -f "$DATA_FILE" ]; then
  DATA_FILE="$ROOT/data/datasets/${DATASET^}.csv"
fi

echo "=================================================="
echo " DC Transpiler — End-to-End Demo"
echo " Dataset : $DATASET"
echo "=================================================="
echo ""

# ── 1. Dependencies ───────────────────────────────────────────────────────────
echo "[1/5] Checking dependencies..."
for cmd in docker node npm; do
  command -v "$cmd" &>/dev/null || { echo "Error: '$cmd' not found. Please install it."; exit 1; }
done
echo "OK"
echo ""

# ── 2. Install npm packages ───────────────────────────────────────────────────
echo "[2/5] Installing npm packages..."
cd "$ROOT"
npm install --silent
echo "OK"
echo ""

# ── 3. Start PostgreSQL via Docker Compose ────────────────────────────────────
echo "[3/5] Starting PostgreSQL (docker-compose)..."
docker compose up -d --wait 2>/dev/null || docker-compose up -d 2>/dev/null
echo "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 20); do
  docker exec dc-transpiler-db pg_isready -U postgres -d dctest -q && break
  sleep 1
done
echo "PostgreSQL ready."
echo ""

# ── 4. Download data if not present ──────────────────────────────────────────
if [ ! -f "$DATA_FILE" ]; then
  echo "[4/5] Dataset not found locally. Downloading from DCValidity..."
  bash "$ROOT/scripts/download-data.sh" "$DATASET"
else
  echo "[4/5] Dataset already present: $DATA_FILE"
fi
echo ""

# ── 5. Run DCs ────────────────────────────────────────────────────────────────
echo "[5/5] Loading dataset and running Denial Constraints..."
echo ""
PGPASSWORD=postgres npx ts-node "$ROOT/src/run-dcs.ts" \
  --csv   "$DATA_FILE" \
  --table "$DATASET" \
  --dcs   "$DC_FILE" \
  --host  localhost \
  --port  5432 \
  --db    dctest \
  --user  postgres \
  --pass  postgres \
  --verbose

echo ""
echo "=================================================="
echo " Demo complete."
echo " To stop PostgreSQL: docker compose down"
echo "=================================================="
