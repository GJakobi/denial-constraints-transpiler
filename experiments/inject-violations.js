#!/usr/bin/env node
/**
 * inject-violations.js
 *
 * Injects controlled violations of a 2-predicate denial constraint of the
 * form ¬(t0.X == t1.X ^ t0.Y <> t1.Y) into a DCValidity-style CSV.
 *
 * The intended target for the tax500k RQ3 experiment is DC #10:
 *   ¬(t0.tax500k.fname == t1.tax500k.fname ^ t0.tax500k.gender <> t1.tax500k.gender)
 *
 * Why this design (full justification in PROGRESS.md, section
 * "Violation injection for RQ3 — decisions and justifications"):
 *
 *   • Injection rate is 5 % of rows (matches the HoloClean noise rate from
 *     Rekatsinas et al., VLDB 2017). Linear-in-N violation growth keeps the
 *     algorithmic-scaling signal dominant on the RQ3 curve, while keeping
 *     the output volume bounded and predictable.
 *
 *   • The target DC has columns (fname, gender) that are referenced by no
 *     other DC in tax500k.txt — injecting against DC #10 cannot perturb
 *     the violation sets of the other 29 DCs.
 *
 *   • Each injected pair (i, j) is forced to share a UNIQUE synthetic
 *     value in the equality column (e.g. "INJECT_000001"). Because the
 *     synthetic value is unique per pair, no other row in the dataset can
 *     ever share it — so the only pair the planted violation creates is
 *     exactly (i, j). This prevents "injection overshoot" (extra
 *     unplanned violations against rows that happened to share the
 *     equality value).
 *
 *   • The script emits both a modified CSV and a ground-truth JSON file
 *     listing the injected pairs as [i+1, j+1] (1-based, matching the
 *     PostgreSQL SERIAL convention used by compare.js). Both tools must
 *     report every injected pair — providing a third RQ1 sanity check
 *     on top of the FACET cross-comparison.
 *
 * Output is also a DCValidity-style CSV (header retains the `(Type)`
 * annotations) so that `prepare-dataset.js` and the transpiler can both
 * consume it directly without further conversion.
 *
 * Usage:
 *   node experiments/inject-violations.js \
 *     --in        denial-constraints-transpiler/data/datasets/tax500k.csv \
 *     --out       experiments/results/rq3/10000/subset_10000_injected.csv \
 *     --injected  experiments/results/rq3/10000/injected.json \
 *     --n         10000 \
 *     [--rate     0.05]   \
 *     [--seed     42]     \
 *     [--eq-col   FName]  \
 *     [--ineq-col Gender]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI parsing ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

let inFile      = '';
let outCsv      = '';
let outInjected = '';
let N           = 0;
let rate        = 0.05;
let seed        = 42;
let eqColName   = 'FName';
let ineqColName = 'Gender';

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--in':       inFile      = argv[++i]; break;
    case '--out':      outCsv      = argv[++i]; break;
    case '--injected': outInjected = argv[++i]; break;
    case '--n':        N           = parseInt(argv[++i], 10); break;
    case '--rate':     rate        = parseFloat(argv[++i]); break;
    case '--seed':     seed        = parseInt(argv[++i], 10); break;
    case '--eq-col':   eqColName   = argv[++i]; break;
    case '--ineq-col': ineqColName = argv[++i]; break;
    default:
      console.error(`Unknown argument: ${argv[i]}`);
      process.exit(1);
  }
}

if (!inFile || !outCsv || !outInjected || !Number.isFinite(N) || N <= 0) {
  console.error(
    'Usage: --in <csv> --out <csv> --injected <json> --n <rows> ' +
    '[--rate 0.05] [--seed 42] [--eq-col FName] [--ineq-col Gender]'
  );
  process.exit(1);
}
if (!(rate > 0 && rate < 1)) {
  console.error(`--rate must be in (0, 1); got ${rate}`);
  process.exit(1);
}

// ─── Deterministic RNG (mulberry32) ──────────────────────────────────────────
// Self-contained so the script has zero npm dependencies.

function makeRng(s) {
  let state = (s | 0) >>> 0;
  return function () {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = makeRng(seed);

// ─── Read and parse the source CSV ───────────────────────────────────────────

const raw = fs.readFileSync(inFile, 'utf-8');
const lines = raw.split('\n');
while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

if (lines.length < 2) {
  console.error('Input CSV has no data rows.');
  process.exit(1);
}

const headerLine  = lines[0];
const headerCells = headerLine.split(',');

// Locate the equality and inequality columns by their bare names (the part
// before any `(Type)` annotation). Case-insensitive match.
function findColIdx(bareName) {
  const want = bareName.toLowerCase();
  const idx  = headerCells.findIndex(cell => {
    const bare = cell.trim().replace(/\([^)]+\)\s*$/, '').trim().toLowerCase();
    return bare === want;
  });
  if (idx < 0) {
    console.error(
      `Column "${bareName}" not found in header.\n` +
      `Header was: ${headerLine.slice(0, 200)}`
    );
    process.exit(1);
  }
  return idx;
}

const eqIdx   = findColIdx(eqColName);
const ineqIdx = findColIdx(ineqColName);

// Take exactly the first N data rows (header + N).
const dataLines = lines.slice(1, 1 + N);
if (dataLines.length < N) {
  console.error(
    `Requested N=${N} but the input has only ${dataLines.length} data rows.`
  );
  process.exit(1);
}
const rows = dataLines.map(line => line.split(','));

// Collect the distinct values present in the inequality column. We need at
// least two so we can force rows[j] to differ from rows[i].
const ineqValues = [...new Set(rows.map(r => r[ineqIdx]))];
if (ineqValues.length < 2) {
  console.error(
    `Column "${ineqColName}" has fewer than 2 distinct values in the first ` +
    `${N} rows; cannot inject "<>" violations.`
  );
  process.exit(1);
}

// ─── Sample disjoint pairs via Fisher-Yates partial shuffle ──────────────────

const pairCount  = Math.floor(N * rate / 2);
const sampleSize = pairCount * 2;

if (pairCount < 1) {
  console.error(
    `pairCount = floor(N * rate / 2) = 0 (N=${N}, rate=${rate}); ` +
    `nothing to inject.`
  );
  process.exit(1);
}
if (sampleSize > N) {
  console.error(`Need ${sampleSize} distinct rows but only have N=${N}.`);
  process.exit(1);
}

const indices = new Array(N);
for (let i = 0; i < N; i++) indices[i] = i;
for (let i = 0; i < sampleSize; i++) {
  const j   = i + Math.floor(rng() * (N - i));
  const tmp = indices[i];
  indices[i] = indices[j];
  indices[j] = tmp;
}
const sampled = indices.slice(0, sampleSize);

// ─── Apply the injection ─────────────────────────────────────────────────────

// We use a synthetic unique value in the equality column for each pair
// (e.g. "INJECT_000001") so that the planted (i, j) violation is the ONLY
// pair in the dataset containing that value — zero overshoot guarantee.

const injectedPairs = [];

for (let p = 0; p < pairCount; p++) {
  const i = sampled[2 * p];
  const j = sampled[2 * p + 1];

  const syntheticEq = `INJECT_${String(p + 1).padStart(6, '0')}`;
  rows[i][eqIdx] = syntheticEq;
  rows[j][eqIdx] = syntheticEq;

  if (rows[i][ineqIdx] === rows[j][ineqIdx]) {
    rows[j][ineqIdx] = ineqValues.find(v => v !== rows[i][ineqIdx]);
  }

  // 1-based pair IDs (PostgreSQL SERIAL convention). compare.js already
  // normalizes pairs to {min, max}, so we don't need to sort here, but we
  // emit the smaller id first for readability of injected.json.
  const pgI = Math.min(i, j) + 1;
  const pgJ = Math.max(i, j) + 1;
  injectedPairs.push([pgI, pgJ]);
}

// ─── Write outputs ───────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(path.resolve(outCsv)),      { recursive: true });
fs.mkdirSync(path.dirname(path.resolve(outInjected)), { recursive: true });

const outLines = [headerLine, ...rows.map(r => r.join(','))];
fs.writeFileSync(outCsv, outLines.join('\n') + '\n');

const groundTruth = {
  source_csv:     path.basename(inFile),
  rows_in_subset: N,
  injection_rate: rate,
  seed,
  eq_col:         eqColName,
  ineq_col:       ineqColName,
  pair_count:     pairCount,
  pairs:          injectedPairs,
};
fs.writeFileSync(outInjected, JSON.stringify(groundTruth, null, 2) + '\n');

const dirtyPct = ((pairCount * 2) / N * 100).toFixed(2);
console.log(
  `Injected ${pairCount} violating pairs ` +
  `(${pairCount * 2} dirty rows = ${dirtyPct}% of ${N}) ` +
  `into ${path.basename(outCsv)}`
);
console.log(`Ground truth written to ${path.basename(outInjected)}`);
