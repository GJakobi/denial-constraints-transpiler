#!/usr/bin/env bash
# run-k-trials-rq3-concurrent.sh
#
# RQ3.2 — Concurrency scalability of the transpiler.
#
# Drives the (concurrency × trial) grid for a single sweep MODE:
#
#   - clean : intra-query parallelism disabled (max_parallel_workers_per_gather=0
#             per session). Isolates session-level concurrency as the only
#             independent variable. The PG global cap (max_parallel_workers)
#             is irrelevant because no workers are requested.
#
#   - tuned : intra-query parallelism left at PG default (gather=2). The CALLER
#             must have raised max_parallel_workers and max_worker_processes in
#             postgresql.conf before invoking this script (see
#             PROGRESS.md → "Concurrency scalability experiment (RQ3.2)"); the
#             script verifies the cap is sufficient and aborts if not.
#
# For each concurrency level c in {1,2,4,8,16,24,32} (overridable) we run K
# trials. Each trial: one warm-up batch (discarded), then one measured batch
# of all N DCs submitted with at most c in flight.
#
# Output (namespaced by mode and dataset):
#   experiments/results-k-trials-rq3-concurrent-<MODE>/<DATASET>-<SIZE>/
#     driver.log
#     trial_<K>/c<C>/per_query.csv
#     trial_<K>/c<C>/stats.json
#     trial_<K>/c<C>/run.log
#
# Usage:
#   MODE=clean DATASET=Hospital SIZE=100000 K=5 \
#     bash experiments/run-k-trials-rq3-concurrent.sh
#
# Defaults: MODE=clean, DATASET=Hospital, SIZE=100000, K=5,
#           CONCURRENCIES="1 2 4 8 16 24 32"

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir.
TRANSPILER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"

MODE="${MODE:-clean}"
DATASET="${DATASET:-Hospital}"
SIZE="${SIZE:-100000}"
K="${K:-5}"
CONCURRENCIES_DEFAULT="1 2 4 8 16 24 32"
CONCURRENCIES="${CONCURRENCIES:-$CONCURRENCIES_DEFAULT}"

DC_FILE="$TRANSPILER_DIR/examples/dcs/${DATASET}.txt"
DATA_FILE="$TRANSPILER_DIR/data/datasets/${DATASET}.csv"

# DB env vars (mirror run-rq3.sh)
PGHOST="${PGHOST:-localhost}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-dctest}"
PGUSER="${PGUSER:-$(whoami)}"
PGPASSWORD="${PGPASSWORD:-}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD

# Sanity checks
[ -f "$DC_FILE" ]   || { echo "ERROR: DC file not found: $DC_FILE"; exit 1; }
[ -f "$DATA_FILE" ] || {
  CAP="$(echo "$DATASET" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')"
  CAP_FILE="$TRANSPILER_DIR/data/datasets/${CAP}.csv"
  [ -f "$CAP_FILE" ] && DATA_FILE="$CAP_FILE" \
    || { echo "ERROR: Dataset CSV not found: $DATA_FILE"; exit 1; }
}
case "$MODE" in clean|tuned) ;; *) echo "ERROR: MODE must be 'clean' or 'tuned'"; exit 1;; esac
for cmd in node npm psql; do
  command -v "$cmd" &>/dev/null \
    || { echo "ERROR: '$cmd' not found. Run: conda activate gfj22"; exit 1; }
done

# For tuned mode, verify the global cap was raised by the operator. We need
# enough total parallel workers that the highest c level can still satisfy
# gather=2 per query: max_parallel_workers >= 2 * max(CONCURRENCIES).
MAX_C=0
for c in $CONCURRENCIES; do (( c > MAX_C )) && MAX_C=$c; done
NEEDED_WORKERS=$(( MAX_C * 2 ))

read -r CUR_MAX_WORKERS CUR_GATHER <<<"$(psql -d "$PGDATABASE" -tA -F' ' \
  -c "SELECT setting FROM pg_settings WHERE name = 'max_parallel_workers'
      UNION ALL
      SELECT setting FROM pg_settings WHERE name = 'max_parallel_workers_per_gather'
      ORDER BY 1 DESC;" | tr '\n' ' ')"
# Note: ORDER BY 1 DESC puts the larger number (max_parallel_workers, typically)
# first. We tolerate either order by just reading both.
ACTUAL_MAX_WORKERS=$(psql -d "$PGDATABASE" -tAc "SHOW max_parallel_workers")
ACTUAL_GATHER=$(psql -d "$PGDATABASE" -tAc "SHOW max_parallel_workers_per_gather")
ACTUAL_PROCS=$(psql -d "$PGDATABASE" -tAc "SHOW max_worker_processes")

if [ "$MODE" = "tuned" ]; then
  if [ "$ACTUAL_MAX_WORKERS" -lt "$NEEDED_WORKERS" ]; then
    cat <<EOM
ERROR: tuned mode requires max_parallel_workers >= ${NEEDED_WORKERS} (2 * max c = ${MAX_C}),
       but PG reports max_parallel_workers = ${ACTUAL_MAX_WORKERS}.
       Edit ~/pgdata/postgresql.conf:
         max_parallel_workers = ${NEEDED_WORKERS}
         max_worker_processes = $(( NEEDED_WORKERS + 16 ))
       then restart PG (pg_ctl -D ~/pgdata restart) and re-run.
EOM
    exit 2
  fi
  if [ "$ACTUAL_GATHER" -lt 2 ]; then
    echo "WARNING: tuned mode expected max_parallel_workers_per_gather >= 2, found ${ACTUAL_GATHER}."
  fi
fi

OUT_BASE="$SCRIPT_DIR/results-k-trials-rq3-concurrent-${MODE}/${DATASET}-${SIZE}"
mkdir -p "$OUT_BASE"
DRIVER_LOG="$OUT_BASE/driver.log"
exec > >(tee -a "$DRIVER_LOG") 2>&1

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ3.2 — Concurrency sweep — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Machine          : $(hostname)"
echo " Mode             : $MODE"
echo " Dataset          : $DATASET (subset size $SIZE rows)"
echo " DC file          : $DC_FILE"
echo " Concurrencies    : $CONCURRENCIES"
echo " Trials per c     : $K"
echo " DB               : ${PGUSER}@${PGHOST}:${PGPORT}/${PGDATABASE}"
echo " PG max_workers   : ${ACTUAL_MAX_WORKERS}   gather: ${ACTUAL_GATHER}   procs: ${ACTUAL_PROCS}"
echo " Mem limit        : $(ulimit -v) KB virtual"
echo " Output           : $OUT_BASE"
echo "══════════════════════════════════════════════════════════════════════"

# npm install once
cd "$TRANSPILER_DIR" && npm install --silent && cd "$ROOT"

# Load the table once at the start of the sweep (skip-load thereafter). All
# trials read the same loaded table; cache state therefore reflects warm steady
# state by the second trial onward, and we run an explicit warm-up batch inside
# each trial anyway to capture the same condition every time.
echo ""
echo "── Pre-loading dataset (subset of $SIZE rows) ──────────────────────"
LOAD_LOG="$OUT_BASE/preload.log"
cd "$TRANSPILER_DIR"
PGPASSWORD="$PGPASSWORD" ./node_modules/.bin/ts-node --transpile-only src/run-concurrent.ts \
  --csv         "$DATA_FILE"   \
  --table       "$DATASET"     \
  --dcs         "$DC_FILE"     \
  --limit       "$SIZE"        \
  --concurrency 1              \
  --mode        "$MODE"        \
  --out         "$OUT_BASE/preload" \
  >> "$LOAD_LOG" 2>&1
cd "$ROOT"
echo "  Preload OK (table $DATASET loaded with $SIZE rows; one c=1 batch executed and discarded)."
echo "  Preload log: $LOAD_LOG"

# Main grid: for each trial, for each concurrency, run one measured batch (with
# warm-up). Outer loop on trial so trials are interleaved across c levels — this
# guards against time-correlated drift (e.g. background noise getting worse
# halfway through the sweep) that would otherwise bias one c level.
for (( k=1; k<=K; k++ )); do
  echo ""
  echo "════════ Trial $k / $K ════════════════════════════════════════════════"
  for c in $CONCURRENCIES; do
    OUT_DIR="$OUT_BASE/trial_${k}/c${c}"
    mkdir -p "$OUT_DIR"
    LOG="$OUT_DIR/run.log"
    echo "  Trial $k, c=$c — $(date '+%H:%M:%S')"
    cd "$TRANSPILER_DIR"
    PGPASSWORD="$PGPASSWORD" ./node_modules/.bin/ts-node --transpile-only src/run-concurrent.ts \
      --skip-load           \
      --table       "$DATASET" \
      --dcs         "$DC_FILE" \
      --concurrency "$c"      \
      --mode        "$MODE"   \
      --warmup                \
      --out         "$OUT_DIR" \
      > "$LOG" 2>&1
    cd "$ROOT"
    MAKESPAN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).makespan_ms.toFixed(1))' "$OUT_DIR/stats.json")
    echo "    makespan: ${MAKESPAN} ms"
  done
done

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " Sweep complete — $(date '+%Y-%m-%d %H:%M:%S')"
echo " Per-trial output: $OUT_BASE/trial_<k>/c<c>/{stats.json, per_query.csv, run.log}"
echo " Next: aggregate-trials-rq3-concurrent.js (to be written)"
echo "══════════════════════════════════════════════════════════════════════"
