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

# Fallback: some dataset filenames are capitalized
if [ ! -f "$DATA_FILE" ]; then
  DATASET_CAP="$(echo "$DATASET" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  DATA_FILE="$ROOT/data/datasets/${DATASET_CAP}.csv"
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

# Check if Docker daemon is actually running before proceeding
if ! docker info &>/dev/null; then
  echo ""
  echo "Error: Docker is not running."
  echo "Please start Docker Desktop (or your Docker daemon) and try again."
  exit 1
fi

if ! docker compose up -d --wait 2>/dev/null && ! docker-compose up -d 2>/dev/null; then
  echo ""
  echo "Error: Failed to start PostgreSQL via Docker Compose."
  echo "Check the output above, then try: docker compose up"
  exit 1
fi

echo "Waiting for PostgreSQL to be ready..."
READY=0
for i in $(seq 1 20); do
  if docker exec dc-transpiler-db pg_isready -U postgres -d dctest -q 2>/dev/null; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -eq 0 ]; then
  echo ""
  echo "Error: PostgreSQL did not become ready in time."
  echo "Try running 'docker compose logs' to see what went wrong."
  exit 1
fi

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
