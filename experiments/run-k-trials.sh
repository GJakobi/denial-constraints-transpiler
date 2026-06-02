#!/usr/bin/env bash
# run-k-trials.sh
#
# Runs run-experiment-server.sh K times on each requested dataset, moving
# the produced artefacts into a per-trial subdirectory after each trial.
# Then invokes aggregate-trials.js to compute mean ± stdev per DC per tool.
#
# Resumable: trials whose summary.json already exists are skipped, so the
# script can be re-invoked after a screen death without losing work.
#
# Usage:
#   bash experiments/run-k-trials.sh                       # K=5, all 3 datasets
#   bash experiments/run-k-trials.sh 3                     # K=3, all 3 datasets
#   bash experiments/run-k-trials.sh 5 tax500k             # K=5, only tax500k
#   bash experiments/run-k-trials.sh 5 Hospital hospital_hc
#
# Defaults: K=5, datasets="tax500k Hospital hospital_hc"
#
# Environment expectations (same as run-experiment-server.sh):
#   - conda activate gfj22 (Node, npm, Python)
#   - ulimit -v 32000000   (set in the parent shell before kicking off)
#   - Java 11+ in PATH
#   - PostgreSQL running locally
#   - FACET JAR at $ROOT/similarity-facet/target/facet-jar-with-dependencies.jar
#
# IMPORTANT: do NOT use `set -e` here. compare.js (called by the inner script)
# exits 1 when there are FACET-unsupported DCs — that is a known and expected
# outcome on Hospital, not a reason to abort the rest of the trials.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir.
TRANSPILER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"

# ── Parse args: optional leading integer = K; remaining args = dataset names ──

K=5
if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; then
  K="$1"
  shift
fi

if [ $# -gt 0 ]; then
  DATASETS=("$@")
else
  DATASETS=(tax500k Hospital hospital_hc)
fi

TRIAL_BASE="$SCRIPT_DIR/results-k-trials"
mkdir -p "$TRIAL_BASE"

START_TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "══════════════════════════════════════════════════════════════════════"
echo " K-trial driver — $START_TS"
echo " Machine : $(hostname)"
echo " K       : $K"
echo " Datasets: ${DATASETS[*]}"
echo " Output  : $TRIAL_BASE"
echo " Mem lim : $(ulimit -v) KB virtual"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# ── Main loop ────────────────────────────────────────────────────────────────

for DATASET in "${DATASETS[@]}"; do
  for TRIAL in $(seq 1 "$K"); do

    TRIAL_DIR="$TRIAL_BASE/trial_${TRIAL}/${DATASET}"
    LOG_FILE="$TRIAL_BASE/trial_${TRIAL}/${DATASET}.log"

    # Resume guard: skip trials whose primary artefact already exists.
    if [ -f "$TRIAL_DIR/transpiler/summary.json" ]; then
      echo "[skip] $DATASET trial ${TRIAL}/${K}: $TRIAL_DIR/transpiler/summary.json exists"
      continue
    fi

    echo "════════════════════════════════════════════════════════════════════"
    echo " $DATASET trial ${TRIAL}/${K} — $(date '+%Y-%m-%d %H:%M:%S')"
    echo "════════════════════════════════════════════════════════════════════"

    # Clear any partial run-experiment-server.sh output from a previous attempt
    rm -rf "$SCRIPT_DIR/results/${DATASET}"

    mkdir -p "$TRIAL_BASE/trial_${TRIAL}"

    # Run the experiment, capturing all output to a per-trial log. We do not
    # care about the inner script's exit status (compare.js may exit 1).
    bash "$SCRIPT_DIR/run-experiment-server.sh" "$DATASET" 2>&1 | tee "$LOG_FILE"
    INNER_EXIT=${PIPESTATUS[0]}

    if [ "$INNER_EXIT" -ne 0 ]; then
      echo "[warn] trial ${TRIAL}/${DATASET}: inner script exited ${INNER_EXIT} (expected on Hospital DCs)"
    fi

    # Move produced artefacts into the per-trial directory. If the inner
    # script failed before producing anything, the move is a no-op.
    mkdir -p "$TRIAL_DIR"
    SRC="$SCRIPT_DIR/results/${DATASET}"
    if [ -d "$SRC/transpiler" ]; then mv "$SRC/transpiler" "$TRIAL_DIR/"; fi
    if [ -d "$SRC/facet" ];      then mv "$SRC/facet"      "$TRIAL_DIR/"; fi
    rm -rf "$SRC"

    echo "[done] trial $TRIAL/$K of $DATASET → $TRIAL_DIR"
    echo ""
  done
done

# ── Aggregate per dataset ─────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════════════════"
echo " Aggregating $K trials × ${#DATASETS[@]} dataset(s)..."
echo "══════════════════════════════════════════════════════════════════════"

for DATASET in "${DATASETS[@]}"; do
  node "$SCRIPT_DIR/aggregate-trials.js"                       \
    --base    "$TRIAL_BASE"                                    \
    --dataset "$DATASET"                                       \
    --k       "$K"                                             \
    --out     "$TRIAL_BASE/aggregated_${DATASET}.json"         \
    --md      "$TRIAL_BASE/aggregated_${DATASET}.md"           \
    || echo "[warn] aggregate-trials.js failed for $DATASET (see output above)"
done

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo " All done — $(date '+%Y-%m-%d %H:%M:%S') (started $START_TS)"
echo " Aggregate files: $TRIAL_BASE/aggregated_*.{json,md}"
echo "══════════════════════════════════════════════════════════════════════"
