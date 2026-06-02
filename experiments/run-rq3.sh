#!/usr/bin/env bash
# run-rq3.sh
#
# RQ3 — Scalability: runs the transpiler and FACET on increasing subsets
# of the tax500k dataset to measure how execution time scales with data size.
#
# Subset sizes (rows, excluding header): 1000 5000 10000 50000 100000 250000
# The full 500k run is covered by run-experiment-server.sh (RQ2).
#
# Output: experiments/results/rq3/
#   rq3_summary.csv    — size, dc_num, transpiler_ms, facet_ms, violations
#   <size>/transpiler/ — per-DC pair files and summary.json
#   <size>/facet/      — per-DC pair files and timing.csv
#
# Prerequisites (same as run-experiment-server.sh):
#   conda activate gfj22 && ulimit -v 32000000
#
# PostgreSQL connection via env vars: PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD
#
# Usage:
#   bash experiments/run-rq3.sh
#   bash experiments/run-rq3.sh 1000 5000 10000   # custom sizes

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir, where
# similarity-facet/ is expected to live alongside it. FACET_JAR can be
# overridden via env for layouts that put it elsewhere.
TRANSPILER_DIR="$(cd "$ROOT" && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"
FACET_JAR="${FACET_JAR:-$ROOT/similarity-facet/target/facet-jar-with-dependencies.jar}"
# DATASET and INJECT are env-overridable so the same driver covers both RQ3
# curves: tax500k (synthetic, INJECT=1) and Hospital (naturally dirty, INJECT=0).
DATASET="${DATASET:-tax500k}"
INJECT="${INJECT:-1}"
DC_FILE="$TRANSPILER_DIR/examples/dcs/${DATASET}.txt"
DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET}.csv"
RQ3_DIR="$SCRIPT_DIR/results/rq3"
SUMMARY_CSV="$RQ3_DIR/rq3_summary.csv"

# Injection config (see PROGRESS.md → "Violation injection for RQ3").
# DC #10 of tax500k.txt: ¬(fname == fname ^ gender <> gender).
INJECT_TARGET_DC=10
INJECT_RATE=0.05
INJECT_SEED=42
INJECT_EQ_COL="FName"
INJECT_INEQ_COL="Gender"

PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-dctest}"
PGUSER="${PGUSER:-$(whoami)}"
PGPASSWORD="${PGPASSWORD:-}"

# Dataset sizes to test (can be overridden via CLI args)
if [ $# -gt 0 ]; then
  SIZES=("$@")
else
  SIZES=(1000 5000 10000 50000 100000 250000)
fi

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ3 — Scalability Experiment — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Machine  : $(hostname)"
echo " Sizes    : ${SIZES[*]}"
echo " DB       : ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
echo " Mem lim  : $(ulimit -v) KB virtual"
echo " Dataset  : ${DATASET}"
if [ "$INJECT" = "1" ]; then
  echo " Injection: DC #${INJECT_TARGET_DC} @ ${INJECT_RATE} (seed=${INJECT_SEED})"
else
  echo " Injection: OFF (naturally dirty dataset)"
fi
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# ── Sanity checks ─────────────────────────────────────────────────────────────
[ -f "$FACET_JAR" ] || { echo "ERROR: FACET JAR not found: $FACET_JAR"; exit 1; }
[ -f "$DC_FILE" ]   || { echo "ERROR: DC file not found: $DC_FILE"; exit 1; }
[ -f "$DATA_FILE" ] || {
  CAP="$(echo "$DATASET" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  CAP_FILE="$TRANSPILER_DIR/data/datasets/${CAP}.csv"
  [ -f "$CAP_FILE" ] && DATA_FILE="$CAP_FILE" \
    || { echo "ERROR: Dataset not found: $DATA_FILE"; exit 1; }
}
for cmd in java node npm; do
  command -v "$cmd" &>/dev/null \
    || { echo "ERROR: '$cmd' not found. Run: conda activate gfj22"; exit 1; }
done

mkdir -p "$RQ3_DIR"
echo "dc_num,size,transpiler_ms,facet_ms,transpiler_violations,facet_violations" \
  > "$SUMMARY_CSV"

# npm install once
cd "$TRANSPILER_DIR" && npm install --silent && cd "$ROOT"

# Read DC strings into an array
mapfile -t DC_STRINGS < <(grep -v '^\s*#\|^\s*$' "$DC_FILE")
DC_COUNT=${#DC_STRINGS[@]}
echo "DCs: $DC_COUNT"
echo ""

# ── Precompute FACET DC CSV (same for all sizes) ────────────────────────────────
FACET_DC_DIR="$RQ3_DIR/facet-dcs"
mkdir -p "$FACET_DC_DIR"
FACET_ALL_DCS="$FACET_DC_DIR/all-dcs.csv"
node "$SCRIPT_DIR/convert-to-facet.js" "$DC_FILE" "$FACET_ALL_DCS"

# Extract per-DC CSV files once
for (( i=0; i<DC_COUNT; i++ )); do
  DC_NUM=$(printf '%03d' $(( i + 1 )))
  sed -n "$(( i + 1 ))p" "$FACET_ALL_DCS" > "$FACET_DC_DIR/dc_${DC_NUM}.csv"
done

# ── Loop over dataset sizes ────────────────────────────────────────────────────
for SIZE in "${SIZES[@]}"; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo " Size: ${SIZE} rows — $(date '+%H:%M:%S')"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

  SIZE_DIR="$RQ3_DIR/$SIZE"
  TRANSPILER_OUT="$SIZE_DIR/transpiler"
  FACET_OUT="$SIZE_DIR/facet"
  mkdir -p "$TRANSPILER_OUT" "$FACET_OUT"

  # ── Create subset CSV (header + first SIZE data rows) ──────────────────────
  SUBSET_CSV="$SIZE_DIR/subset_${SIZE}.csv"
  if [ ! -f "$SUBSET_CSV" ]; then
    echo "  Creating subset CSV (${SIZE} rows)..."
    # Header (line 1) + first SIZE data rows = first SIZE+1 lines. A single head
    # avoids the `tail | head` pipe, whose early close sent SIGPIPE to tail and
    # tripped `set -o pipefail` (exit 141) on large source files.
    head -n "$((SIZE + 1))" "$DATA_FILE" > "$SUBSET_CSV"
  fi

  # ── Inject controlled violations into the subset ────────────────────────────
  # See PROGRESS.md → "Violation injection for RQ3" for the design rationale.
  # Output is in the same DCValidity-style CSV format as the input, so both
  # prepare-dataset.js (FACET) and the transpiler can consume it directly.
  if [ "$INJECT" = "1" ]; then
    INJECTED_CSV="$SIZE_DIR/subset_${SIZE}_injected.csv"
    INJECTED_JSON="$SIZE_DIR/injected.json"
    if [ ! -f "$INJECTED_CSV" ] || [ ! -f "$INJECTED_JSON" ]; then
      echo "  Injecting violations (target DC #${INJECT_TARGET_DC} @ ${INJECT_RATE})..."
      node "$SCRIPT_DIR/inject-violations.js" \
        --in        "$SUBSET_CSV"           \
        --out       "$INJECTED_CSV"         \
        --injected  "$INJECTED_JSON"        \
        --n         "$SIZE"                 \
        --rate      "$INJECT_RATE"          \
        --seed      "$INJECT_SEED"          \
        --eq-col    "$INJECT_EQ_COL"        \
        --ineq-col  "$INJECT_INEQ_COL"
    fi
  else
    # Naturally dirty dataset: no injection, use the raw subset as-is.
    INJECTED_CSV="$SUBSET_CSV"
    INJECTED_JSON=""
  fi

  # Prepare FACET-format CSV from the injected subset
  FACET_DATA_FILE="$FACET_OUT/dataset.csv"
  node "$SCRIPT_DIR/prepare-dataset.js" "$INJECTED_CSV" "$FACET_DATA_FILE"

  # ── Run transpiler on the injected subset ──────────────────────────────────
  # The transpiler derives the FROM table from the table name embedded in each
  # DC string (e.g. "t0.tax500k.col" -> FROM tax500k). The --table arg only
  # names the LOAD target, so it MUST equal the DC's table name; otherwise the
  # queries hit a stale table of the wrong size. loadCSV uses dropIfExists, so
  # each subset cleanly recreates "$DATASET" at the subset's row count.
  echo "  Running transpiler (${SIZE} injected rows, $DC_COUNT DCs)..."
  cd "$TRANSPILER_DIR"
  PGPASSWORD="$PGPASSWORD" npx ts-node src/run-pairs.ts \
    --csv    "$INJECTED_CSV"    \
    --table  "$DATASET"         \
    --dcs    "$DC_FILE"         \
    --out    "$TRANSPILER_OUT"  \
    --host   "$PGHOST"          \
    --port   "$PGPORT"          \
    --db     "$PGDATABASE"      \
    --user   "$PGUSER"          \
    --pass   "$PGPASSWORD"
  cd "$ROOT"
  echo "  Transpiler done."

  # ── Run FACET per DC on this subset ────────────────────────────────────────
  echo "  Running FACET ($DC_COUNT DCs)..."
  FACET_TIMING_CSV="$FACET_OUT/timing.csv"
  FACET_ERRORS_LOG="$FACET_OUT/errors.log"
  echo "dc_num,violations,time_ms" > "$FACET_TIMING_CSV"
  : > "$FACET_ERRORS_LOG"

  for (( i=0; i<DC_COUNT; i++ )); do
    DC_NUM=$(printf '%03d' $(( i + 1 )))
    SINGLE_DC_CSV="$FACET_DC_DIR/dc_${DC_NUM}.csv"
    FACET_RESULT="$FACET_OUT/dc_${DC_NUM}.txt"

    FACET_START=$(date +%s%3N)
    if ! java -jar "$FACET_JAR" facet \
          "$FACET_DATA_FILE" "$SINGLE_DC_CSV" tuplepairs "$FACET_RESULT" \
          2>/dev/null
    then
      echo "  DC $DC_NUM: FACET returned non-zero exit" >> "$FACET_ERRORS_LOG"
    fi
    touch "$FACET_RESULT"
    FACET_END=$(date +%s%3N)
    FACET_TIME_MS=$(( FACET_END - FACET_START ))

    FACET_VIOLATIONS=$(grep -c '(' "$FACET_RESULT" 2>/dev/null || true)
    FACET_VIOLATIONS=${FACET_VIOLATIONS:-0}
    echo "$(( i + 1 )),${FACET_VIOLATIONS},${FACET_TIME_MS}" >> "$FACET_TIMING_CSV"
  done
  echo "  FACET done."

  # ── Write per-DC rows to global summary CSV ─────────────────────────────────
  TRANSPILER_SUMMARY="$TRANSPILER_OUT/summary.json"
  if command -v python3 &>/dev/null && [ -f "$TRANSPILER_SUMMARY" ]; then
    python3 - "$TRANSPILER_SUMMARY" "$FACET_TIMING_CSV" "$SIZE" "$SUMMARY_CSV" <<'PYEOF'
import json, csv, sys

t_file, f_file, size, out_file = sys.argv[1:]
t_data = json.load(open(t_file))
f_rows = list(csv.DictReader(open(f_file)))

with open(out_file, 'a') as fout:
    for i, t_entry in enumerate(t_data):
        f_entry = f_rows[i] if i < len(f_rows) else {}
        fout.write(','.join([
            str(t_entry.get('dc_num', i+1)),
            str(size),
            str(t_entry.get('time_ms', 0)),
            str(f_entry.get('time_ms', 0)),
            str(max(t_entry.get('violations', 0), 0)),
            str(f_entry.get('violations', 0)),
        ]) + '\n')
PYEOF
  fi

  # ── Compare transpiler vs FACET (+ ground-truth check when injecting) ──────
  if [ "$INJECT" = "1" ]; then
    echo "  Comparing transpiler vs FACET (with ground-truth check on DC #${INJECT_TARGET_DC})..."
    node "$SCRIPT_DIR/compare.js"                                     \
      --transpiler     "$TRANSPILER_OUT"                              \
      --facet          "$FACET_OUT"                                   \
      --dcs            "$DC_FILE"                                     \
      --log            "$FACET_ERRORS_LOG"                            \
      --injected-truth "$INJECTED_JSON"                               \
      --target-dc      "$INJECT_TARGET_DC"                            \
      || echo "  WARNING: compare.js reported issues at size $SIZE — see output above."
  else
    echo "  Comparing transpiler vs FACET..."
    node "$SCRIPT_DIR/compare.js"                                     \
      --transpiler     "$TRANSPILER_OUT"                              \
      --facet          "$FACET_OUT"                                   \
      --dcs            "$DC_FILE"                                     \
      --log            "$FACET_ERRORS_LOG"                            \
      || echo "  WARNING: compare.js reported issues at size $SIZE — see output above."
  fi

  echo "  Size ${SIZE}: done"
  echo ""

done

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ3 complete — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Summary: $SUMMARY_CSV"
echo ""
echo " Preview:"
head -5 "$SUMMARY_CSV"
echo "  ..."
echo "══════════════════════════════════════════════════════════════════════"
