#!/usr/bin/env bash
# run-rq4.sh — RQ4: Join Elimination benchmark on tax500k
#
# Usage (from the transpiler repo root):
#   bash experiments/run-rq4.sh
#   bash experiments/run-rq4.sh --skip-setup   # if tax_gender already exists
#
# Environment variables (override PG connection):
#   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
#
# Outputs:
#   experiments/results-rq4/rq4_results.json
#   experiments/results-rq4/rq4_summary.md

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
TRANSPILER_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

K="${K:-5}"
WARMUP="${WARMUP:-1}"
OUT_DIR="$SCRIPT_DIR/results-rq4"

# Build --warmup flag
WARMUP_FLAG=""
if [ "$WARMUP" = "1" ]; then
  WARMUP_FLAG="--warmup"
fi

# Pass through any extra args (e.g. --skip-setup)
EXTRA_ARGS="$*"

echo "══════════════════════════════════════════════════════════════════════"
echo " RQ4 — Join Elimination Experiment"
echo " Dataset : tax500k"
echo " k       : $K trials (warmup: $WARMUP)"
echo " DB      : ${PGUSER:-postgres}@${PGHOST:-localhost}:${PGPORT:-5432}/${PGDATABASE:-dctest}"
echo " Out     : $OUT_DIR"
echo "══════════════════════════════════════════════════════════════════════"
echo ""

cd "$TRANSPILER_DIR"

npm install --silent

npx ts-node src/run-rq4.ts \
  --table   tax500k         \
  --k       "$K"            \
  $WARMUP_FLAG              \
  --out     "$OUT_DIR"      \
  ${EXTRA_ARGS}

echo ""
echo "Done. Results:"
echo "  $OUT_DIR/rq4_results.json"
echo "  $OUT_DIR/rq4_summary.md"
