#!/usr/bin/env node
/**
 * analyze-timing.js
 *
 * Re-analyzes an experiment run by extracting FACET's internal timing
 * breakdown (LoadingTime, CardOrStats-PlanTime, DetectionTime) from the
 * run-experiment-server.sh log file, and cross-referencing it with the
 * transpiler's per-DC summary.json.
 *
 * Produces two views of the comparison:
 *
 *   Mode A — End-to-end ("cold start" tool):
 *     FACET   = LoadingTime + Planning + Detection + Output
 *     Transpiler = SQL execute  (plus the *amortized* load reported separately)
 *
 *   Mode B — Detection-only ("steady state"):
 *     FACET   = DetectionTime  (just the algorithmic work, no CSV loading)
 *     Transpiler = SQL execute  (same as before)
 *
 * Mode B is the fairer comparison once both tools have the data in memory.
 *
 * Usage:
 *   node experiments/analyze-timing.js \
 *     --label "DCValidity Hospital" \
 *     --log   results-serra2-hospital/hospital_dcvalidity.log \
 *     --transpiler-summary results-serra2-hospital/Hospital/transpiler/summary.json
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let label = 'experiment';
let logFile = '';
let summaryFile = '';

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--label':              label       = argv[++i]; break;
    case '--log':                logFile     = path.resolve(argv[++i]); break;
    case '--transpiler-summary': summaryFile = path.resolve(argv[++i]); break;
  }
}

if (!logFile || !summaryFile) {
  console.error('Usage: --label <str> --log <path> --transpiler-summary <path>');
  process.exit(1);
}

// ─── Parse FACET timing breakdowns from run log ───────────────────────────────

/**
 * The run log captures FACET's stdout for each per-DC invocation.
 * We look for the two lines FacetMocker emits at the end of each invocation:
 *
 *   HH:MM:SS [main] mockers.FacetMocker  - LoadingTime | EmbeddingsMappingTime | CardOrStats-PlanTime |  DetectionTime (in ms): 757 | 0 | 75 | 306
 *   HH:MM:SS [main] mockers.FacetMocker  - Execution Time (in ms): 381
 *
 * Returns an array (in order of FACET invocation, i.e., DC index) of:
 *   { loading_ms, embedding_ms, plan_ms, detection_ms, execution_ms }
 *
 * For DCs FACET refused to plan, no such entry exists — we fill those with
 * null in the cross-reference step.
 */
function parseFacetTimings(logPath) {
  const content = fs.readFileSync(logPath, 'utf-8');
  const breakdownRe = /LoadingTime[^:]+\(in ms\):\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/g;
  const execRe      = /Execution Time \(in ms\):\s*(\d+)/g;

  const breakdowns = [...content.matchAll(breakdownRe)].map(m => ({
    loading_ms:   parseInt(m[1], 10),
    embedding_ms: parseInt(m[2], 10),
    plan_ms:      parseInt(m[3], 10),
    detection_ms: parseInt(m[4], 10),
  }));
  const execs = [...content.matchAll(execRe)].map(m => parseInt(m[1], 10));

  // Pair them up — Execution Time line immediately follows the breakdown line
  return breakdowns.map((b, i) => ({
    ...b,
    execution_ms: execs[i] ?? null,
  }));
}

/**
 * Parse the "  DC NNN: K pair(s)  [T ms]" wall-time lines from the shell
 * loop in run-experiment-server.sh. These are FACET-invocation wall times
 * — the same numbers stored in timing.csv. Use them to align FACET timing
 * entries to DC indices (since FACET-errored DCs don't emit FacetMocker
 * lines but DO emit a shell wall-time line).
 *
 * Returns array of { dc_num, wall_ms, errored }.
 */
function parseShellFacetWallTimes(logPath) {
  const content = fs.readFileSync(logPath, 'utf-8');

  // Two formats: fixed (post-fix) and broken (first tax500k run with the
  // PAIR_COUNT="0\n0" bug, where the count and "pair(s) [ms]" land on two lines).
  //   fixed:  "  DC 028: 0 pair(s)  [1534 ms]"
  //   broken: "  DC 028: 0\n0 pair(s)  [1534 ms]"
  // Match both by allowing any whitespace (including newline) between count and 'pair(s)'.
  const fixedRe  = /^\s{2}DC\s+(\d{3}):\s+(\d+)\s+pair\(s\)\s+\[(\d+)\s+ms\]/gm;
  const brokenRe = /^\s{2}DC\s+(\d{3}):\s+\d+\s*\n\s*\d+\s+pair\(s\)\s+\[(\d+)\s+ms\]/gm;
  const errRe    = /DC (\d{3}): FACET returned non-zero exit/g;

  const entries = [];
  for (const m of content.matchAll(fixedRe)) {
    entries.push({ dc_num: parseInt(m[1], 10), pairs: parseInt(m[2], 10), wall_ms: parseInt(m[3], 10) });
  }
  for (const m of content.matchAll(brokenRe)) {
    entries.push({ dc_num: parseInt(m[1], 10), pairs: null, wall_ms: parseInt(m[2], 10) });
  }

  // Deduplicate by dc_num (in case both regexes accidentally hit the same line)
  const byDc = new Map();
  for (const e of entries) if (!byDc.has(e.dc_num)) byDc.set(e.dc_num, e);
  const dedup = [...byDc.values()].sort((a, b) => a.dc_num - b.dc_num);

  const errored = new Set([...content.matchAll(errRe)].map(m => parseInt(m[1], 10)));
  for (const e of dedup) e.errored = errored.has(e.dc_num);
  return dedup;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const transpiler = JSON.parse(fs.readFileSync(summaryFile, 'utf-8'));
const facetBreakdowns = parseFacetTimings(logFile);
const shellEntries    = parseShellFacetWallTimes(logFile);

// Align FACET breakdowns to DC indices: walk shell entries in order, consuming
// one breakdown per non-errored entry.
let breakdownIdx = 0;
const facetByDc = new Map();
for (const e of shellEntries) {
  if (e.errored) {
    facetByDc.set(e.dc_num, { ...e, breakdown: null });
  } else {
    const b = facetBreakdowns[breakdownIdx++] ?? null;
    facetByDc.set(e.dc_num, { ...e, breakdown: b });
  }
}

// Compose per-DC comparison rows
const rows = transpiler.map(t => {
  const f = facetByDc.get(t.dc_num);
  return {
    dc_num:               t.dc_num,
    transpiler_ms:        t.time_ms,
    transpiler_pairs:     t.violations,
    facet_wall_ms:        f?.wall_ms ?? null,
    facet_loading_ms:     f?.breakdown?.loading_ms ?? null,
    facet_plan_ms:        f?.breakdown?.plan_ms ?? null,
    facet_detection_ms:   f?.breakdown?.detection_ms ?? null,
    facet_execution_ms:   f?.breakdown?.execution_ms ?? null,
    facet_errored:        f?.errored ?? false,
  };
});

// ─── Aggregates ───────────────────────────────────────────────────────────────

const supported = rows.filter(r => !r.facet_errored);

function sum(arr, key) { return arr.reduce((s, r) => s + (r[key] ?? 0), 0); }

const transpilerTotalMs   = sum(supported, 'transpiler_ms');
const facetTotalWallMs    = sum(supported, 'facet_wall_ms');
const facetTotalLoadMs    = sum(supported, 'facet_loading_ms');
const facetTotalPlanMs    = sum(supported, 'facet_plan_ms');
const facetTotalDetectMs  = sum(supported, 'facet_detection_ms');
const facetTotalExecMs    = sum(supported, 'facet_execution_ms');

function ratio(a, b) { return b === 0 ? '—' : (a / b).toFixed(2); }

console.log(`══════════════════════════════════════════════════════════════════════`);
console.log(` ${label}`);
console.log(` (${rows.length} DCs total; ${supported.length} comparable, ${rows.length - supported.length} FACET-unsupported)`);
console.log(`══════════════════════════════════════════════════════════════════════`);
console.log('');
console.log('Mode A — End-to-end (FACET wall time per invocation, includes CSV reload)');
console.log('  FACET total wall time          : ' + facetTotalWallMs    + ' ms (' + (facetTotalWallMs/1000).toFixed(2) + ' s)');
console.log('    of which CSV loading         : ' + facetTotalLoadMs    + ' ms (' + (100 * facetTotalLoadMs / facetTotalWallMs).toFixed(1) + '%)');
console.log('    of which planning            : ' + facetTotalPlanMs    + ' ms (' + (100 * facetTotalPlanMs / facetTotalWallMs).toFixed(1) + '%)');
console.log('    of which detection           : ' + facetTotalDetectMs  + ' ms (' + (100 * facetTotalDetectMs / facetTotalWallMs).toFixed(1) + '%)');
console.log('  Transpiler total SQL exec time : ' + transpilerTotalMs   + ' ms (' + (transpilerTotalMs/1000).toFixed(2) + ' s)');
console.log('  Ratio FACET / Transpiler       : ' + ratio(facetTotalWallMs, transpilerTotalMs) + '×  (>1 means transpiler faster)');
console.log('');
console.log('Mode B — Detection-only (FACET LoadingTime subtracted)');
console.log('  FACET detection time           : ' + facetTotalDetectMs + ' ms (' + (facetTotalDetectMs/1000).toFixed(3) + ' s)');
console.log('  FACET execution time           : ' + facetTotalExecMs   + ' ms (planning + detection)');
console.log('  Transpiler SQL exec time       : ' + transpilerTotalMs  + ' ms');
console.log('  Ratio (Transpiler / FACET detection)        : ' + ratio(transpilerTotalMs, facetTotalDetectMs)  + '×  (>1 means transpiler slower)');
console.log('  Ratio (Transpiler / FACET execution)        : ' + ratio(transpilerTotalMs, facetTotalExecMs)    + '×');
console.log('');
console.log('Per-DC averages (across the ' + supported.length + ' comparable DCs)');
console.log('  Transpiler SQL exec  : ' + (transpilerTotalMs / supported.length).toFixed(1) + ' ms / DC');
console.log('  FACET wall           : ' + (facetTotalWallMs   / supported.length).toFixed(1) + ' ms / DC');
console.log('  FACET detection-only : ' + (facetTotalDetectMs / supported.length).toFixed(1) + ' ms / DC');
console.log('');

// Top 5 slowest DCs by transpiler time
const slowest = [...supported].sort((a, b) => b.transpiler_ms - a.transpiler_ms).slice(0, 5);
console.log('Top 5 slowest DCs (by transpiler exec time):');
for (const r of slowest) {
  console.log('  DC ' + String(r.dc_num).padStart(3, '0') +
              ': transp ' + r.transpiler_ms + ' ms, FACET wall ' + r.facet_wall_ms +
              ' ms (load ' + r.facet_loading_ms + ', detect ' + r.facet_detection_ms + ') — ' +
              r.transpiler_pairs + ' pairs');
}
console.log('');

// DCs where the conclusion flips between Mode A and Mode B
const flips = supported.filter(r => {
  const fasterModeA = r.transpiler_ms < r.facet_wall_ms;
  const fasterModeB = r.transpiler_ms < r.facet_detection_ms;
  return fasterModeA !== fasterModeB;
});
if (flips.length > 0) {
  console.log('DCs where the winner FLIPS between Mode A and Mode B:');
  for (const r of flips) {
    console.log('  DC ' + String(r.dc_num).padStart(3, '0') +
                ': transp ' + r.transpiler_ms + ' ms; FACET wall ' + r.facet_wall_ms +
                ' / detect ' + r.facet_detection_ms);
  }
  console.log('');
}
