#!/usr/bin/env node
/**
 * aggregate-trials.js
 *
 * Aggregates per-DC timing across K trials produced by run-k-trials.sh.
 *
 * For each DC of a given dataset, computes mean ± stdev (sample stdev,
 * Bessel-corrected) and coefficient of variation (CV = stdev / mean) for:
 *   - transpiler SQL execution time     (from transpiler/summary.json)
 *   - FACET wall time per invocation    (from facet/timing.csv)
 *   - FACET algorithm-only detection ms (parsed from the per-trial run log
 *     emitted by run-experiment-server.sh; this captures FacetMocker's
 *     internal "LoadingTime | EmbeddingsMappingTime | CardOrStats-PlanTime
 *     | DetectionTime" line per DC invocation, same parser as
 *     analyze-timing.js).
 *
 * The CV is the key signal we report back to the advisor: per Eduardo's
 * 2026-05-14 note, "a quantidade de vezes que voce executa depende desse
 * desvio ficar pequeno". As a rule of thumb, CV < 5% indicates negligible
 * variance; CV > 15% means more trials are needed.
 *
 * Inputs are read from:
 *   <base>/trial_<N>/<dataset>/transpiler/summary.json
 *   <base>/trial_<N>/<dataset>/facet/timing.csv
 *   <base>/trial_<N>/<dataset>.log
 *
 * Outputs:
 *   <out>.json: full per-DC aggregate (all trial values + stats)
 *   <md>:       markdown summary table for quick inspection
 *
 * Usage:
 *   node experiments/aggregate-trials.js \
 *     --base    experiments/results-k-trials \
 *     --dataset tax500k                       \
 *     --k       5                             \
 *     --out     experiments/results-k-trials/aggregated_tax500k.json \
 *     --md      experiments/results-k-trials/aggregated_tax500k.md
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let base = '', dataset = '', k = 0, outJson = '', outMd = '';
for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--base':    base    = path.resolve(argv[++i]); break;
    case '--dataset': dataset = argv[++i];               break;
    case '--k':       k       = parseInt(argv[++i], 10); break;
    case '--out':     outJson = path.resolve(argv[++i]); break;
    case '--md':      outMd   = path.resolve(argv[++i]); break;
  }
}
if (!base || !dataset || !k || !outJson) {
  console.error(
    'Usage: --base <dir> --dataset <name> --k <N> --out <json> [--md <md>]'
  );
  process.exit(1);
}

// ─── Per-trial loaders ───────────────────────────────────────────────────────

/**
 * Read a single trial's artefacts:
 *   - transpiler summary.json (required; null trial otherwise)
 *   - FACET timing.csv         (optional)
 *   - run log                  (optional — for the FacetMocker breakdown)
 *
 * Returns null if the transpiler summary is missing (trial failed).
 */
function loadTrial(trialNum) {
  const trialDir   = path.join(base, `trial_${trialNum}`, dataset);
  const summaryFp  = path.join(trialDir, 'transpiler', 'summary.json');
  const timingFp   = path.join(trialDir, 'facet',      'timing.csv');
  const logFp      = path.join(base, `trial_${trialNum}`, `${dataset}.log`);

  if (!fs.existsSync(summaryFp)) return null;

  const tEntries = JSON.parse(fs.readFileSync(summaryFp, 'utf-8'));

  const facetByDc = {};
  if (fs.existsSync(timingFp)) {
    const rows = fs.readFileSync(timingFp, 'utf-8').split('\n').slice(1);
    for (const row of rows) {
      // dc_num,"dc_string",violations,time_ms
      const m = row.match(/^(\d+),"([^"]*)",(\d+),(\d+)\s*$/);
      if (m) {
        facetByDc[parseInt(m[1], 10)] = {
          violations: parseInt(m[3], 10),
          wall_ms:    parseInt(m[4], 10),
        };
      }
    }
  }

  // Parse the FacetMocker breakdown lines from the per-trial log. Each
  // non-errored DC invocation emits one such line in order; we align them
  // to DC numbers by walking the shell DC-N progress lines.
  const breakdownByDc = new Map();
  if (fs.existsSync(logFp)) {
    const log = fs.readFileSync(logFp, 'utf-8');

    const breakdownRe = /LoadingTime[^:]+\(in ms\):\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(\d+)/g;
    const breakdowns  = [];
    for (const m of log.matchAll(breakdownRe)) {
      breakdowns.push({
        loading_ms:   parseInt(m[1], 10),
        embedding_ms: parseInt(m[2], 10),
        plan_ms:      parseInt(m[3], 10),
        detection_ms: parseInt(m[4], 10),
      });
    }

    // Shell wall-time progress lines: "  DC 028: 0 pair(s)  [1534 ms]"
    const dcLineRe   = /^\s{2}DC\s+(\d{3}):/gm;
    const dcNums     = [...log.matchAll(dcLineRe)].map(m => parseInt(m[1], 10));

    const erroredRe  = /DC (\d{3}): FACET returned non-zero exit/g;
    const errored    = new Set([...log.matchAll(erroredRe)].map(m => parseInt(m[1], 10)));

    let bi = 0;
    for (const n of dcNums) {
      if (errored.has(n)) continue;     // FACET-errored DCs emit no breakdown line
      breakdownByDc.set(n, breakdowns[bi++] ?? null);
    }
  }

  return { tEntries, facetByDc, breakdownByDc };
}

// ─── Statistics helpers ──────────────────────────────────────────────────────

function mean(xs)  { return xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length; }
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1));
}
function cv(xs) {
  const m = mean(xs);
  return (m == null || m === 0) ? null : stdev(xs) / m;
}
function summarize(xs) {
  const finite = xs.filter(x => Number.isFinite(x));
  return {
    trials: finite,
    mean:   mean(finite),
    stdev:  stdev(finite),
    cv:     cv(finite),
  };
}

// ─── Aggregate ───────────────────────────────────────────────────────────────

const trials = [];
for (let t = 1; t <= k; t++) {
  const data = loadTrial(t);
  if (data) trials.push({ trial: t, ...data });
  else      console.warn(`[warn] trial ${t}: data missing, skipping`);
}
if (trials.length === 0) {
  console.error(`No usable trials found for dataset "${dataset}" under ${base}`);
  process.exit(1);
}

// Use trial 1's DC list as the canonical ordering (all trials should have
// the same set; we'll warn if a later trial omits a DC).
const dcNums = trials[0].tEntries.map(e => e.dc_num);

const dcAggregates = dcNums.map(dcNum => {
  const transpilerMs    = [];
  const facetWallMs     = [];
  const facetDetectMs   = [];
  const facetLoadMs     = [];
  let violations        = 0;

  for (const tr of trials) {
    const tEntry = tr.tEntries.find(e => e.dc_num === dcNum);
    if (tEntry) {
      transpilerMs.push(tEntry.time_ms);
      violations = Math.max(violations, tEntry.violations | 0);
    }
    const fEntry = tr.facetByDc[dcNum];
    if (fEntry && Number.isFinite(fEntry.wall_ms)) facetWallMs.push(fEntry.wall_ms);

    const bd = tr.breakdownByDc.get(dcNum);
    if (bd) {
      facetDetectMs.push(bd.detection_ms);
      facetLoadMs.push(bd.loading_ms);
    }
  }

  return {
    dc_num:               dcNum,
    violations,
    transpiler_ms:        summarize(transpilerMs),
    facet_wall_ms:        summarize(facetWallMs),
    facet_detection_ms:   summarize(facetDetectMs),
    facet_loading_ms:     summarize(facetLoadMs),
  };
});

const report = {
  dataset,
  k_requested: k,
  trials_used: trials.length,
  generated:   new Date().toISOString(),
  dcs:         dcAggregates,
};
fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(report, null, 2) + '\n');
console.log(`Wrote ${outJson}  (${dcAggregates.length} DCs from ${trials.length} trial(s))`);

// ─── Markdown summary ────────────────────────────────────────────────────────

if (outMd) {
  const fmt = m =>
    m.mean == null ? '—' :
    `${m.mean.toFixed(1)} ± ${m.stdev.toFixed(1)} (CV ${m.cv == null ? '—' : (m.cv * 100).toFixed(1) + '%'})`;

  const lines = [
    `# Aggregated timing — ${dataset}`,
    ``,
    `Trials used: **${trials.length}** of ${k} requested. Generated: ${report.generated}.`,
    ``,
    `Convention: \`mean ± stdev (CV%)\`. CV < 5 % = negligible variance; CV > 15 % = more trials advised.`,
    ``,
    `| DC | Violations | Transpiler (ms) | FACET wall (ms) | FACET detection-only (ms) | FACET loading (ms) |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const r of dcAggregates) {
    lines.push(
      `| ${String(r.dc_num).padStart(3, '0')} | ${r.violations} | ${fmt(r.transpiler_ms)} | ` +
      `${fmt(r.facet_wall_ms)} | ${fmt(r.facet_detection_ms)} | ${fmt(r.facet_loading_ms)} |`
    );
  }

  // Whole-dataset rollup (sum the means across DCs for a single headline).
  const sumMean = key => dcAggregates.reduce((s, r) => s + (r[key].mean || 0), 0);
  lines.push(``);
  lines.push(`### Dataset rollup (sum of per-DC means)`);
  lines.push(``);
  lines.push(`- Transpiler total       : ${sumMean('transpiler_ms').toFixed(0)} ms`);
  lines.push(`- FACET wall total       : ${sumMean('facet_wall_ms').toFixed(0)} ms`);
  lines.push(`- FACET detection total  : ${sumMean('facet_detection_ms').toFixed(0)} ms`);
  lines.push(`- FACET loading total    : ${sumMean('facet_loading_ms').toFixed(0)} ms`);

  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, lines.join('\n') + '\n');
  console.log(`Wrote ${outMd}`);
}
