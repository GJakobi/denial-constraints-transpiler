#!/usr/bin/env bash
# run-k-trials-rq3.sh
#
# K-trial driver for RQ3 (scalability on tax500k subsets with injected
# violations). Wraps run-rq3.sh; runs it K independent times, moving the
# entire experiments/results/rq3/ artefact directory into a per-trial
# subdirectory after each trial.
#
# The injection itself is deterministic (fixed seed in run-rq3.sh — see
# INJECT_SEED) so every trial operates on the SAME injected data. Variance
# across trials therefore reflects only timing noise, not data sampling.
# This is the right design for the advisor's "média ± desvio padrão"
# requirement.
#
# Resumable: trials whose rq3_summary.csv already exists are skipped, so the
# wrapper can be re-invoked safely after a screen death.
#
# Hospital subsets (also requested by the advisor) are NOT covered by this
# wrapper — they require a separate dataset-aware version of run-rq3.sh.
# That is parked as the next task after this k-trial sweep finishes.
#
# Usage:
#   bash experiments/run-k-trials-rq3.sh                       # K=5, default sizes
#   bash experiments/run-k-trials-rq3.sh 3                     # K=3, default sizes
#   bash experiments/run-k-trials-rq3.sh 5 1000 5000 10000     # K=5, custom sizes
#
# Defaults: K=5, sizes="1000 5000 10000 50000 100000 250000"
#
# Environment expectations (same as run-rq3.sh):
#   - conda activate gfj22       (Node, npm, Python)
#   - ulimit -v 32000000         (set before kicking off)
#   - Java 11+ in PATH
#   - PostgreSQL running locally
#   - FACET JAR present
#
# IMPORTANT: no `set -e`. compare.js may exit 1 when there are FACET-errored
# DCs (expected on tax500k DC 30 — ≥1 equality + ≥2 differentThan form).
# That should not abort subsequent trials.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# experiments/ lives inside the transpiler repo. TRANSPILER_DIR is the parent
# of this script's directory; ROOT is the parent of the transpiler dir.
TRANSPILER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT="$(cd "$TRANSPILER_DIR/.." && pwd)"

# DATASET / INJECT are passed through (exported) to run-rq3.sh so this wrapper
# covers both RQ3 curves: tax500k (synthetic, INJECT=1) and Hospital
# (naturally dirty, INJECT=0). Output is namespaced per dataset so the two
# sweeps don't collide.
export DATASET="${DATASET:-tax500k}"
export INJECT="${INJECT:-1}"

# ── Parse args: optional leading integer = K; remaining = subset sizes ──────

K=5
if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -lt 1000 ]; then
  # Heuristic: an integer < 1000 is K; >=1000 is a subset size.
  # (Smallest valid subset is 1000 rows; largest K we'd ever pick is well below it.)
  K="$1"
  shift
fi

# Remaining args (if any) are subset sizes — forwarded verbatim to run-rq3.sh.
SIZE_ARGS=("$@")

# tax500k keeps the original (already-populated) path; other datasets get a
# dataset-suffixed base so they don't overwrite it or trip the resume guard.
if [ "$DATASET" = "tax500k" ]; then
  TRIAL_BASE="$SCRIPT_DIR/results-k-trials-rq3"
else
  TRIAL_BASE="$SCRIPT_DIR/results-k-trials-rq3-$DATASET"
fi
INNER_OUT="$SCRIPT_DIR/results/rq3"
mkdir -p "$TRIAL_BASE"

START_TS=$(date '+%Y-%m-%d %H:%M:%S')
echo "══════════════════════════════════════════════════════════════════════"
echo " RQ3 k-trial driver — $START_TS"
echo " Machine : $(hostname)"
echo " K       : $K"
if [ "${#SIZE_ARGS[@]}" -gt 0 ]; then
  echo " Sizes   : ${SIZE_ARGS[*]} (overriding run-rq3.sh defaults)"
else
  echo " Sizes   : (run-rq3.sh defaults: 1000 5000 10000 50000 100000 250000)"
fi
echo " Output  : $TRIAL_BASE"
echo " Mem lim : $(ulimit -v) KB virtual"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

# ── Main loop ────────────────────────────────────────────────────────────────

for TRIAL in $(seq 1 "$K"); do

  TRIAL_DIR="$TRIAL_BASE/trial_${TRIAL}/rq3"
  LOG_FILE="$TRIAL_BASE/trial_${TRIAL}/rq3.log"

  # Resume guard: skip trials whose rq3_summary.csv is already present.
  if [ -f "$TRIAL_DIR/rq3_summary.csv" ]; then
    echo "[skip] RQ3 trial ${TRIAL}/${K}: $TRIAL_DIR/rq3_summary.csv exists"
    continue
  fi

  echo "════════════════════════════════════════════════════════════════════"
  echo " RQ3 trial ${TRIAL}/${K} — $(date '+%Y-%m-%d %H:%M:%S')"
  echo "════════════════════════════════════════════════════════════════════"

  # Wipe any partial output from a previous failed run so the inject-cache
  # check inside run-rq3.sh starts clean.
  rm -rf "$INNER_OUT"

  mkdir -p "$TRIAL_BASE/trial_${TRIAL}"

  # Run the inner sweep, capturing all output to a per-trial log.
  bash "$SCRIPT_DIR/run-rq3.sh" "${SIZE_ARGS[@]}" 2>&1 | tee "$LOG_FILE"
  INNER_EXIT=${PIPESTATUS[0]}

  if [ "$INNER_EXIT" -ne 0 ]; then
    echo "[warn] RQ3 trial ${TRIAL}: inner script exited ${INNER_EXIT} (FACET-unsupported DC 30 is expected)"
  fi

  # Move the produced rq3/ artefact directory into the per-trial location.
  if [ -d "$INNER_OUT" ]; then
    mkdir -p "$TRIAL_DIR"
    # Move contents (use shopt to include hidden files if any).
    shopt -s dotglob nullglob
    mv "$INNER_OUT"/* "$TRIAL_DIR/" 2>/dev/null || true
    shopt -u dotglob nullglob
    rmdir "$INNER_OUT" 2>/dev/null || true
  fi

  echo "[done] RQ3 trial $TRIAL/$K → $TRIAL_DIR"
  echo ""
done

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ3 k-trial sweep complete — $(date '+%Y-%m-%d %H:%M:%S') (started $START_TS)"
echo " Per-trial artefacts: $TRIAL_BASE/trial_<N>/rq3/"
echo ""
echo " Next step: aggregate-trials-rq3.js (to be written) — reads each trial's"
echo "            rq3_summary.csv and computes mean ± stdev per (DC, size)."
echo "══════════════════════════════════════════════════════════════════════"
