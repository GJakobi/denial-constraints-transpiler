#!/usr/bin/env bash
# run-experiment-server.sh
#
# RQ1 + RQ2: Transpiler vs FACET correctness and performance on a full dataset.
# Server version — uses a local PostgreSQL installation (no Docker).
#
# Prerequisites:
#   - conda activate gfj22         (provides Node.js / npm)
#   - ulimit -v 32000000           (set BEFORE running; avoids OOM crashes)
#   - Java 11+ in PATH             (for FACET)
#   - PostgreSQL running locally   (createdb dctest beforehand)
#   - FACET JAR at ~/tcc/similarity-facet/target/facet-jar-with-dependencies.jar
#
# PostgreSQL connection (override via environment variables if needed):
#   PGHOST      default: localhost
#   PGPORT      default: 5432
#   PGDATABASE  default: dctest
#   PGUSER      default: current unix user
#   PGPASSWORD  default: ""   (peer auth — usually correct on shared servers)
#
# Usage:
#   bash experiments/run-experiment-server.sh [airport|tax500k]

set -euo pipefail

DATASET="${1:-tax500k}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir, where
# similarity-facet/ is expected to live alongside it.
TRANSPILER_DIR="$(cd "$ROOT" && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"
FACET_JAR="${FACET_JAR:-$ROOT/similarity-facet/target/facet-jar-with-dependencies.jar}"
DC_FILE="$TRANSPILER_DIR/examples/dcs/${DATASET}.txt"
DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET}.csv"
RESULTS_DIR="$SCRIPT_DIR/results/${DATASET}"
TRANSPILER_OUT="$RESULTS_DIR/transpiler"
FACET_OUT="$RESULTS_DIR/facet"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-dctest}"
PGUSER="${PGUSER:-$(whoami)}"
PGPASSWORD="${PGPASSWORD:-}"

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ1 + RQ2 Experiment — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Machine : $(hostname)"
echo " Dataset : $DATASET"
echo " DB      : ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
echo " Results : $RESULTS_DIR"
echo " Mem lim : $(ulimit -v) KB virtual"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# ── Sanity checks ─────────────────────────────────────────────────────────────

if [ ! -f "$FACET_JAR" ]; then
  echo "ERROR: FACET JAR not found: $FACET_JAR"
  echo "Copy it from your local machine:"
  echo "  scp -J macalan.inf.ufpr.br ~/Documents/TCC/similarity-facet/target/facet-jar-with-dependencies.jar \\"
  echo "    gfj22@serra2:~/tcc/similarity-facet/target/"
  exit 1
fi

if [ ! -f "$DC_FILE" ]; then
  echo "ERROR: DC file not found: $DC_FILE"
  exit 1
fi

# Handle case-insensitive dataset filename (tax500k vs Tax500k)
if [ ! -f "$DATA_FILE" ]; then
  CAP="$(echo "$DATASET" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  DATA_FILE_CAP="$TRANSPILER_DIR/data/datasets/${CAP}.csv"
  if [ -f "$DATA_FILE_CAP" ]; then
    DATA_FILE="$DATA_FILE_CAP"
  else
    echo "ERROR: Dataset not found: $DATA_FILE"
    echo "Run setup-server.sh first."
    exit 1
  fi
fi

for cmd in java node npm; do
  command -v "$cmd" &>/dev/null \
    || { echo "ERROR: '$cmd' not found. Run: conda activate gfj22"; exit 1; }
done

mkdir -p "$TRANSPILER_OUT" "$FACET_OUT"

# Count non-blank, non-comment lines (single pass).
DC_COUNT=$(grep -cv '^\s*\(#\|$\)' "$DC_FILE")
echo "DCs to process: $DC_COUNT"
echo ""

# ── 1. npm install ─────────────────────────────────────────────────────────────
echo "[1/5] npm install..."
cd "$TRANSPILER_DIR" && npm install --silent && cd "$ROOT"
echo "OK"
echo ""

# ── 2. Prepare FACET inputs ────────────────────────────────────────────────────
echo "[2/5] Preparing FACET inputs..."
FACET_DATA_FILE="$FACET_OUT/dataset.csv"
node "$SCRIPT_DIR/prepare-dataset.js" "$DATA_FILE" "$FACET_DATA_FILE"

FACET_ALL_DCS="$FACET_OUT/all-dcs.csv"
node "$SCRIPT_DIR/convert-to-facet.js" "$DC_FILE" "$FACET_ALL_DCS"
echo "OK"
echo ""

# ── 3. Run transpiler ──────────────────────────────────────────────────────────
echo "[3/5] Running transpiler (${DC_COUNT} DCs on $(wc -l < "$DATA_FILE") rows)..."
TRANSPILER_WALL_START=$(date +%s%3N)
cd "$TRANSPILER_DIR"
PGPASSWORD="$PGPASSWORD" npx ts-node src/run-pairs.ts \
  --csv   "$DATA_FILE" \
  --table "$DATASET"   \
  --dcs   "$DC_FILE"   \
  --out   "$TRANSPILER_OUT" \
  --host  "$PGHOST"    \
  --port  "$PGPORT"    \
  --db    "$PGDATABASE" \
  --user  "$PGUSER"    \
  --pass  "$PGPASSWORD"
TRANSPILER_WALL_END=$(date +%s%3N)
cd "$ROOT"
TRANSPILER_WALL_MS=$(( TRANSPILER_WALL_END - TRANSPILER_WALL_START ))
echo ""
echo "Transpiler wall time: ${TRANSPILER_WALL_MS} ms"
echo ""

# ── 4. Run FACET (one invocation per DC) ──────────────────────────────────────
echo "[4/5] Running FACET (${DC_COUNT} DCs)..."

FACET_TIMING_CSV="$FACET_OUT/timing.csv"
FACET_ERRORS_LOG="$FACET_OUT/errors.log"
echo "dc_num,dc_string,violations,time_ms" > "$FACET_TIMING_CSV"
: > "$FACET_ERRORS_LOG"   # truncate any previous errors

FACET_TOTAL_MS=0
DC_INDEX=0

while IFS= read -r LINE; do
  # Skip comment and blank lines
  [[ "$LINE" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${LINE//[[:space:]]/}" ]] && continue

  DC_INDEX=$(( DC_INDEX + 1 ))
  DC_NUM=$(printf '%03d' "$DC_INDEX")
  SINGLE_DC_CSV="$FACET_OUT/dc_${DC_NUM}.csv"
  FACET_RESULT="$FACET_OUT/dc_${DC_NUM}.txt"

  # Extract the corresponding FACET DC row
  sed -n "${DC_INDEX}p" "$FACET_ALL_DCS" > "$SINGLE_DC_CSV"

  FACET_START=$(date +%s%3N)
  if ! java -jar "$FACET_JAR" facet \
        "$FACET_DATA_FILE" "$SINGLE_DC_CSV" tuplepairs "$FACET_RESULT" \
        2>/dev/null
  then
    echo "  DC $DC_NUM: FACET returned non-zero exit (may be OK)"
    echo "  DC $DC_NUM: FACET returned non-zero exit" >> "$FACET_ERRORS_LOG"
  fi

  # FACET does not create the output file on 0 violations — ensure it exists
  touch "$FACET_RESULT"
  FACET_END=$(date +%s%3N)
  FACET_TIME_MS=$(( FACET_END - FACET_START ))
  FACET_TOTAL_MS=$(( FACET_TOTAL_MS + FACET_TIME_MS ))

  # grep -c always prints a count and returns non-zero only when the count is 0.
  # Using `|| echo 0` here previously concatenated two zeros (grep's "0" then
  # echo's "0") which broke the CSV. Suppress grep's exit status with `|| true`
  # instead, and keep just the count line from grep.
  PAIR_COUNT=$(grep -c '(' "$FACET_RESULT" 2>/dev/null || true)
  PAIR_COUNT=${PAIR_COUNT:-0}
  echo "  DC ${DC_NUM}: ${PAIR_COUNT} pair(s)  [${FACET_TIME_MS} ms]"

  # Escape DC string for CSV (replace commas inside the DC with spaces)
  SAFE_DC="${LINE//,/ }"
  echo "${DC_INDEX},\"${SAFE_DC}\",${PAIR_COUNT},${FACET_TIME_MS}" >> "$FACET_TIMING_CSV"

done < "$DC_FILE"

echo ""
echo "FACET total time: ${FACET_TOTAL_MS} ms"
echo ""

# ── 5. Compare outputs (RQ1) ──────────────────────────────────────────────────
echo "[5/5] Comparing outputs..."
echo "══════════════════════════════════════════════════════════════════════"
node "$SCRIPT_DIR/compare.js" \
  --transpiler "$TRANSPILER_OUT" \
  --facet      "$FACET_OUT"      \
  --dcs        "$DC_FILE"        \
  --log        "$FACET_ERRORS_LOG"

# ── Final report ───────────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " Done — $(date '+%Y-%m-%d %H:%M:%S')"
echo ""
echo " Timing (RQ2):"
# Use awk for the ms→s conversion so the formatting works regardless of the
# user's locale (Brazilian pt_BR uses "," for decimals, which breaks printf).
awk -v ms="$TRANSPILER_WALL_MS" 'BEGIN { printf "   Transpiler wall time : %d ms  (%.1f s)\n", ms, ms/1000 }'
awk -v ms="$FACET_TOTAL_MS"      'BEGIN { printf "   FACET total DC time  : %d ms  (%.1f s)\n", ms, ms/1000 }'
echo ""
echo " Result files:"
echo "   Transpiler per-DC pairs   : $TRANSPILER_OUT/dc_NNN.txt"
echo "   Transpiler timing JSON    : $TRANSPILER_OUT/summary.json"
echo "   FACET per-DC pairs        : $FACET_OUT/dc_NNN.txt"
echo "   FACET timing CSV          : $FACET_TIMING_CSV"
echo "══════════════════════════════════════════════════════════════════════"
