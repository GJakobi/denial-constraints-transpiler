#!/usr/bin/env bash
# run-experiment.sh
#
# End-to-end RQ1 experiment: runs both the transpiler and FACET on a dataset
# and compares their outputs pair-by-pair.
#
# Prerequisites:
#   - Docker running (for PostgreSQL)
#   - Java 11+ (for FACET)
#   - Node.js 18+ and npm
#
# Usage:
#   ./experiments/run-experiment.sh [airport|tax500k]  (default: airport)
#
# Output:
#   experiments/results/<dataset>/transpiler/dc_NNN.txt  — transpiler pairs
#   experiments/results/<dataset>/facet/dc_NNN.txt       — FACET pairs
#   experiments/results/<dataset>/transpiler/summary.json — timing + counts

set -euo pipefail

DATASET="${1:-airport}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir.
TRANSPILER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"
FACET_JAR="${FACET_JAR:-$ROOT/similarity-facet/target/facet-jar-with-dependencies.jar}"
DC_FILE="$TRANSPILER_DIR/examples/dcs/${DATASET}.txt"
DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET}.csv"
RESULTS_DIR="$SCRIPT_DIR/results/${DATASET}"
TRANSPILER_OUT="$RESULTS_DIR/transpiler"
FACET_OUT="$RESULTS_DIR/facet"

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ1 Experiment: $DATASET"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# ── 0. Sanity checks ──────────────────────────────────────────────────────────

if [ ! -f "$FACET_JAR" ]; then
  echo "Error: FACET JAR not found at $FACET_JAR"
  echo "Expected: ~/Documents/TCC/similarity-facet/target/facet-jar-with-dependencies.jar"
  exit 1
fi

if [ ! -f "$DC_FILE" ]; then
  echo "Error: DC file not found at $DC_FILE"
  exit 1
fi

for cmd in docker java node npm; do
  command -v "$cmd" &>/dev/null || { echo "Error: '$cmd' not found."; exit 1; }
done

mkdir -p "$TRANSPILER_OUT" "$FACET_OUT"

# ── 1. Download dataset if needed ─────────────────────────────────────────────

if [ ! -f "$DATA_FILE" ]; then
  DATASET_CAP="$(echo "$DATASET" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  DATA_FILE_CAP="$TRANSPILER_DIR/data/datasets/${DATASET_CAP}.csv"
  if [ -f "$DATA_FILE_CAP" ]; then
    DATA_FILE="$DATA_FILE_CAP"
  else
    echo "[1/5] Downloading $DATASET dataset from DCValidity..."
    # download-data.sh may fail on the optional ts-node auto-conversion step
    # (which we don't need — DC files are already in examples/dcs/). Ignore it.
    cd "$TRANSPILER_DIR" && bash scripts/download-data.sh "$DATASET" || true
    cd "$ROOT"
    # Re-check both casing variants
    [ -f "$TRANSPILER_DIR/data/datasets/${DATASET}.csv" ]     && DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET}.csv"
    [ -f "$TRANSPILER_DIR/data/datasets/${DATASET_CAP}.csv" ] && DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET_CAP}.csv"
  fi
fi
echo "[1/5] Dataset: $DATA_FILE"

# ── 2. Install npm packages ───────────────────────────────────────────────────

echo "[2/5] Installing npm packages..."
cd "$TRANSPILER_DIR" && npm install --silent && cd "$ROOT"
echo "OK"

# ── 3. Start PostgreSQL ───────────────────────────────────────────────────────

echo "[3/5] Starting PostgreSQL..."
cd "$TRANSPILER_DIR"
if ! docker info &>/dev/null; then
  echo "Error: Docker is not running. Start Docker Desktop and retry."
  exit 1
fi
docker compose up -d --wait 2>/dev/null || docker-compose up -d 2>/dev/null
for i in $(seq 1 20); do
  docker exec dc-transpiler-db pg_isready -U postgres -d dctest -q 2>/dev/null && break
  sleep 1
done
cd "$ROOT"
echo "PostgreSQL ready."

# ── 4. Prepare FACET inputs (dataset + DCs) ───────────────────────────────────

echo "[4/5] Preparing FACET inputs..."

# FACET requires typed headers: "COLNAME TYPE" instead of DCValidity's "colname(Type)"
FACET_DATA_FILE="$RESULTS_DIR/facet/dataset.csv"
node "$SCRIPT_DIR/prepare-dataset.js" "$DATA_FILE" "$FACET_DATA_FILE"

# Convert DC notation to FACET CSV format
FACET_ALL_DCS="$FACET_OUT/all-dcs.csv"
node "$SCRIPT_DIR/convert-to-facet.js" "$DC_FILE" "$FACET_ALL_DCS"

# Count DCs (non-comment, non-empty lines)
DC_COUNT=$(grep -c -v '^\s*#' "$DC_FILE" | tr -d '[:space:]') || DC_COUNT=0
echo "DCs to process: $DC_COUNT"

# ── 5. Run transpiler ─────────────────────────────────────────────────────────

echo ""
echo "[5a/5] Running transpiler..."
TRANSPILER_START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
cd "$TRANSPILER_DIR"
PGPASSWORD=postgres npx ts-node src/run-pairs.ts \
  --csv   "$DATA_FILE" \
  --table "$DATASET" \
  --dcs   "$DC_FILE" \
  --out   "$TRANSPILER_OUT" \
  --host localhost --port 5432 --db dctest --user postgres --pass postgres
TRANSPILER_END_MS=$(python3 -c "import time; print(int(time.time()*1000))")
cd "$ROOT"
echo "Transpiler wall time: $((TRANSPILER_END_MS - TRANSPILER_START_MS)) ms"

# ── 6. Run FACET (once per DC) ────────────────────────────────────────────────

echo ""
echo "[5b/5] Running FACET (once per DC)..."

# Read each non-comment DC line
DC_INDEX=0
while IFS= read -r LINE; do
  [[ "$LINE" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${LINE// }" ]]           && continue

  DC_INDEX=$((DC_INDEX + 1))
  DC_NUM=$(printf '%03d' "$DC_INDEX")
  SINGLE_DC_CSV="$FACET_OUT/dc_${DC_NUM}.csv"
  FACET_RESULT="$FACET_OUT/dc_${DC_NUM}.txt"

  # Extract the corresponding line from the converted FACET CSV
  sed -n "${DC_INDEX}p" "$FACET_ALL_DCS" > "$SINGLE_DC_CSV"

  FACET_START_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  java -jar "$FACET_JAR" facet "$FACET_DATA_FILE" "$SINGLE_DC_CSV" tuplepairs "$FACET_RESULT" 2>/dev/null \
    || echo "  FACET DC $DC_NUM: non-zero exit — check $SINGLE_DC_CSV"
  # FACET does not create the output file when there are 0 violations — ensure it exists
  [ -f "$FACET_RESULT" ] || touch "$FACET_RESULT"
  FACET_END_MS=$(python3 -c "import time; print(int(time.time()*1000))")
  FACET_TIME=$((FACET_END_MS - FACET_START_MS))

  PAIR_COUNT=$(grep -c '(' "$FACET_RESULT" 2>/dev/null || echo 0)
  echo "  DC $DC_NUM: $PAIR_COUNT line(s) in output  [${FACET_TIME} ms]"

done < "$DC_FILE"

# ── 7. Compare ────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " Comparison"
echo "══════════════════════════════════════════════════════════════════════"
node "$SCRIPT_DIR/compare.js" \
  --transpiler "$TRANSPILER_OUT" \
  --facet      "$FACET_OUT" \
  --dcs        "$DC_FILE"

echo ""
echo "Results saved in: $RESULTS_DIR"
