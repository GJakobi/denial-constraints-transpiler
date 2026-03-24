#!/usr/bin/env bash
# download-data.sh
#
# Downloads the benchmark datasets and sound DCs from the DCValidity repository.
# Source: https://github.com/nosocalgroc/DCValidity
#
# Usage: ./scripts/download-data.sh [dataset]
#   dataset: airport | tax500k | Hospital | flights | food | ncvoter | all (default: all)

set -euo pipefail

DCVALIDITY_REPO="https://github.com/nosocalgroc/DCValidity.git"
DATA_DIR="$(cd "$(dirname "$0")/.." && pwd)/data"
DATASETS="${1:-all}"

echo "=================================================="
echo " DCValidity Data Downloader"
echo " Source: $DCVALIDITY_REPO"
echo "=================================================="

# Check dependencies
if ! command -v git &>/dev/null; then
  echo "Error: git is required. Please install it and retry."
  exit 1
fi

# Clone or update DCValidity into a temp directory
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo ""
echo "Cloning DCValidity (datasets + soundDCs only, no history)..."
git clone --depth 1 --filter=blob:none --sparse "$DCVALIDITY_REPO" "$TMP_DIR" 2>/dev/null
cd "$TMP_DIR"
git sparse-checkout set datasets soundDCs 2>/dev/null
echo "Done."

# Decide which datasets to copy
if [ "$DATASETS" = "all" ]; then
  NAMES=("airport" "tax500k" "Hospital" "flights" "food" "ncvoter")
else
  NAMES=("$DATASETS")
fi

mkdir -p "$DATA_DIR/datasets" "$DATA_DIR/soundDCs"

for NAME in "${NAMES[@]}"; do
  # Dataset CSV (name may be Name.csv or name.csv)
  CSV_FILE=""
  for f in "$TMP_DIR/datasets/${NAME}.csv" "$TMP_DIR/datasets/${NAME^}.csv"; do
    [ -f "$f" ] && CSV_FILE="$f" && break
  done

  if [ -n "$CSV_FILE" ]; then
    cp "$CSV_FILE" "$DATA_DIR/datasets/"
    echo "Copied dataset: $(basename "$CSV_FILE")"
  else
    echo "Warning: dataset CSV not found for '$NAME'"
  fi

  # Sound DCs file
  DC_FILE=""
  for f in "$TMP_DIR/soundDCs/${NAME}" "$TMP_DIR/soundDCs/${NAME^}"; do
    [ -f "$f" ] && DC_FILE="$f" && break
  done

  if [ -n "$DC_FILE" ]; then
    cp "$DC_FILE" "$DATA_DIR/soundDCs/"
    echo "Copied soundDCs: $(basename "$DC_FILE")"

    # Auto-convert to transpiler format
    DC_OUT="$(cd "$(dirname "$0")/.." && pwd)/examples/dcs/${NAME}.txt"
    if command -v npx &>/dev/null; then
      npx ts-node "$(cd "$(dirname "$0")/.." && pwd)/src/convert-dcs.ts" \
        --input "$DC_FILE" \
        --table "$NAME" \
        --output "$DC_OUT" 2>/dev/null && \
        echo "Converted to transpiler format: $DC_OUT"
    fi
  else
    echo "Warning: soundDCs file not found for '$NAME'"
  fi

  echo ""
done

echo "=================================================="
echo " Data ready in: $DATA_DIR"
echo "=================================================="
