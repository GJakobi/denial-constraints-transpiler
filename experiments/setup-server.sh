#!/usr/bin/env bash
# setup-server.sh
#
# One-time setup for running TCC experiments on serra2 (or any Linux server).
# Run this script once after your first login. It clones the transpiler,
# installs Node dependencies, downloads the tax500k dataset, and creates
# the PostgreSQL database.
#
# Prerequisites (must already exist on the server):
#   - conda environment "gfj22" with Node.js and npm
#   - Java 11+ (for FACET)
#   - PostgreSQL accessible from the current user
#   - FACET JAR already copied to ~/tcc/similarity-facet/target/
#
# Usage:
#   conda activate gfj22
#   bash ~/tcc/denial-constraints-transpiler/experiments/setup-server.sh

set -euo pipefail

TCC_ROOT="$HOME/tcc"

echo "═══════════════════════════════════════════════════════════════"
echo " TCC Experiments — Server Setup"
echo " Machine : $(hostname)"
echo " User    : $(whoami)"
echo " TCC root: $TCC_ROOT"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ── 1. Directory structure ────────────────────────────────────────────────────
# The experiments/ folder now lives inside the transpiler repo, so we no longer
# create it standalone; cloning the transpiler brings it in.
mkdir -p "$TCC_ROOT/similarity-facet/target"
echo "[1/5] Directories: OK"

# ── 2. Clone / update transpiler ──────────────────────────────────────────────
TRANSPILER_DIR="$TCC_ROOT/denial-constraints-transpiler"
if [ -d "$TRANSPILER_DIR/.git" ]; then
  echo "[2/5] Transpiler already cloned — pulling latest..."
  cd "$TRANSPILER_DIR" && git pull --ff-only && cd -
else
  echo "[2/5] Cloning transpiler from GitHub..."
  git clone https://github.com/GJakobi/denial-constraints-transpiler "$TRANSPILER_DIR"
fi
mkdir -p "$TRANSPILER_DIR/experiments/results"
echo "Transpiler: OK"

# ── 3. Install npm dependencies ───────────────────────────────────────────────
echo "[3/5] Installing npm packages..."
cd "$TRANSPILER_DIR"
npm install --silent
cd -
echo "npm install: OK"

# ── 4. Download tax500k dataset ───────────────────────────────────────────────
DATASET_FILE="$TRANSPILER_DIR/data/datasets/tax500k.csv"
if [ -f "$DATASET_FILE" ]; then
  ROW_COUNT=$(wc -l < "$DATASET_FILE")
  echo "[4/5] Dataset already present: tax500k.csv ($ROW_COUNT lines)"
else
  echo "[4/5] Downloading tax500k from DCValidity (this may take a few minutes)..."
  bash "$TRANSPILER_DIR/scripts/download-data.sh" tax500k
  echo "Download: OK"
fi

# ── 5. PostgreSQL database ────────────────────────────────────────────────────
PGDB="${PGDATABASE:-dctest}"
echo "[5/5] Checking PostgreSQL database '$PGDB'..."
if createdb "$PGDB" 2>/dev/null; then
  echo "Created database: $PGDB"
else
  echo "Database '$PGDB' already exists — OK"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════════════"
echo " Setup complete!"
echo ""
echo " Verify FACET JAR is present:"
echo "   ls -lh $TCC_ROOT/similarity-facet/target/*.jar"
echo ""
echo " Check versions:"
echo "   node --version && java -version && psql --version"
echo ""
echo " Run RQ1+RQ2 experiment:"
echo "   ulimit -v 32000000"
echo "   bash $TRANSPILER_DIR/experiments/run-experiment-server.sh tax500k"
echo ""
echo " Run RQ3 scalability experiment:"
echo "   ulimit -v 32000000"
echo "   bash $TRANSPILER_DIR/experiments/run-rq3.sh"
echo ""
echo " Run RQ3.2 concurrency experiment (transpiler only):"
echo "   ulimit -v 32000000"
echo "   MODE=clean DATASET=Hospital SIZE=100000 K=5 \\\\"
echo "     bash $TRANSPILER_DIR/experiments/run-k-trials-rq3-concurrent.sh"
echo "═══════════════════════════════════════════════════════════════"
