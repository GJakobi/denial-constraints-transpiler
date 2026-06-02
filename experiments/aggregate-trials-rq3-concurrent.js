#!/usr/bin/env node
/**
 * aggregate-trials-rq3-concurrent.js
 *
 * Aggregates the RQ3.2 concurrency sweep produced by
 * run-k-trials-rq3-concurrent.sh. The layout is:
 *
 *   <base>/trial_<k>/c<c>/stats.json
 *   <base>/trial_<k>/c<c>/per_query.csv
 *
 * stats.json contains: concurrency, mode, n_queries, n_ok, n_error,
 * makespan_ms, sum_latency_ms, p50/p95/max latency, total_violations.
 *
 * We aggregate per (concurrency level) across the K trials:
 *   - makespan_ms : mean ± stdev (Bessel), CV%
 *   - p50/p95/max latency : mean ± stdev
 *   - sum_latency_ms : mean ± stdev
 *   - total_violations : must be identical across trials (sanity check)
 *
 * Derived metrics (using mean(makespan) at each c, with mean(makespan c=1)
 * as the sequential baseline):
 *   - speedup(c) = makespan(1) / makespan(c)
 *   - parallel_efficiency(c) = speedup(c) / c
 *
 * Correctness sanity: total_violations must be invariant across c and across
 * trials. Any divergence is flagged loudly.
 *
 * Usage:
 *   node experiments/aggregate-trials-rq3-concurrent.js \
 *     --base experiments/results-k-trials-rq3-concurrent-clean/Hospital-100000 \
 *     [--k 5] [--out path.json] [--md path.md]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── args ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { base: null, k: 5, out: null, md: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--k') args.k = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--md') args.md = argv[++i];
  }
  if (!args.base) { console.error('ERROR: --base is required'); process.exit(1); }
  if (!args.out) args.out = path.join(args.base, 'aggregated_rq3_concurrent.json');
  if (!args.md)  args.md  = path.join(args.base, 'aggregated_rq3_concurrent.md');
  return args;
}

// ─── stats helpers ───────────────────────────────────────────────────────────
const mean   = xs => xs.reduce((s, x) => s + x, 0) / xs.length;
const stdev  = xs => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
};
const cvPct  = (m, s) => (m === 0 ? 0 : (100 * s) / m);
const fmt    = (m, s, unit = 'ms', digits = 1) =>
  `${m.toFixed(digits)} ± ${s.toFixed(digits)} ${unit} (CV ${cvPct(m, s).toFixed(1)}%)`;

// ─── load ────────────────────────────────────────────────────────────────────
function loadCellTrials(base, k, c) {
  const trials = [];
  for (let t = 1; t <= k; t++) {
    const p = path.join(base, `trial_${t}`, `c${c}`, 'stats.json');
    if (!fs.existsSync(p)) {
      console.error(`  missing: ${p} (trial ${t}, c=${c})`);
      continue;
    }
    trials.push(JSON.parse(fs.readFileSync(p, 'utf8')));
  }
  return trials;
}

function discoverConcurrencies(base) {
  const cs = new Set();
  for (let t = 1; t <= 50; t++) {
    const tDir = path.join(base, `trial_${t}`);
    if (!fs.existsSync(tDir)) continue;
    for (const name of fs.readdirSync(tDir)) {
      const m = /^c(\d+)$/.exec(name);
      if (m) cs.add(parseInt(m[1], 10));
    }
  }
  return Array.from(cs).sort((a, b) => a - b);
}

// ─── main ────────────────────────────────────────────────────────────────────
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(args.base)) {
    console.error(`ERROR: base directory not found: ${args.base}`);
    process.exit(1);
  }
  const concurrencies = discoverConcurrencies(args.base);
  if (concurrencies.length === 0) {
    console.error(`ERROR: no trial_*/c* directories found under ${args.base}`);
    process.exit(1);
  }

  const warnings = [];
  const perC = {};   // c -> aggregated stats
  let mode = null;
  let nQueries = null;
  let datasetSize = null;

  // 1. Per-c aggregation + invariance checks
  for (const c of concurrencies) {
    const trials = loadCellTrials(args.base, args.k, c);
    if (trials.length === 0) {
      warnings.push(`c=${c}: no trials found`);
      continue;
    }
    if (trials.length < args.k) {
      warnings.push(`c=${c}: only ${trials.length} of ${args.k} trials present`);
    }

    // Pin invariant fields
    mode = mode ?? trials[0].mode;
    nQueries = nQueries ?? trials[0].n_queries;
    if (trials.some(t => t.mode !== mode)) {
      warnings.push(`c=${c}: mode differs across trials`);
    }
    if (trials.some(t => t.n_queries !== nQueries)) {
      warnings.push(`c=${c}: n_queries differs across trials`);
    }
    if (trials.some(t => t.n_error > 0)) {
      const erroring = trials.filter(t => t.n_error > 0).length;
      warnings.push(`c=${c}: ${erroring}/${trials.length} trials had query errors`);
    }
    const violationSet = new Set(trials.map(t => t.total_violations));
    if (violationSet.size > 1) {
      warnings.push(`c=${c}: total_violations NOT INVARIANT across trials: ${[...violationSet].join(', ')}`);
    }

    const makespans  = trials.map(t => t.makespan_ms);
    const sums       = trials.map(t => t.sum_latency_ms);
    const p50s       = trials.map(t => t.p50_latency_ms);
    const p95s       = trials.map(t => t.p95_latency_ms);
    const maxes      = trials.map(t => t.max_latency_ms);

    perC[c] = {
      c,
      n_trials: trials.length,
      makespan_mean:   mean(makespans),  makespan_stdev:  stdev(makespans),
      sum_latency_mean: mean(sums),       sum_latency_stdev: stdev(sums),
      p50_mean:        mean(p50s),        p50_stdev:       stdev(p50s),
      p95_mean:        mean(p95s),        p95_stdev:       stdev(p95s),
      max_mean:        mean(maxes),       max_stdev:       stdev(maxes),
      total_violations: trials[0].total_violations,
    };
  }

  // 2. Cross-c invariance: violation counts must be identical at every c
  const cVioSet = new Set(Object.values(perC).map(s => s.total_violations));
  if (cVioSet.size > 1) {
    warnings.push(`Total violations differ across concurrency levels: ${[...cVioSet].join(', ')} (concurrency must not affect correctness)`);
  }

  // 3. Speedup and efficiency vs c=1
  const baseline = perC[1];
  if (!baseline) {
    warnings.push('No c=1 baseline; speedup not computable');
  }
  for (const c of concurrencies) {
    const s = perC[c];
    if (!s) continue;
    if (baseline) {
      s.speedup = baseline.makespan_mean / s.makespan_mean;
      s.efficiency = s.speedup / c;
    }
  }

  // 4. Persist JSON
  const out = {
    base: args.base,
    mode,
    n_queries: nQueries,
    n_trials_requested: args.k,
    concurrencies,
    per_c: perC,
    warnings,
    generated: new Date().toISOString(),
  };
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

  // 5. Markdown report
  const lines = [];
  lines.push(`# Aggregated RQ3.2 — concurrency scalability (mode: ${mode})`);
  lines.push('');
  lines.push(`Trials per cell: ${args.k} requested. Generated: ${out.generated}.`);
  lines.push('');
  lines.push(`Workload: ${nQueries} DCs per batch, dataset prefix on serra2's PG instance.`);
  lines.push('Concurrency means number of independent client sessions; the pool has `max = min = c` connections with `idleTimeoutMillis = 0`, so c PG backend processes are pre-warmed. Per-session `max_parallel_workers_per_gather` is set on each physical connection via `pool.on(\'connect\')` (verified by `SHOW` before measurement). Each measured batch is preceded by a discarded warm-up batch.');
  lines.push('');
  lines.push('## Per-concurrency makespan (the scalability curve)');
  lines.push('');
  lines.push('| c | Makespan (ms) | Speedup vs c=1 | Efficiency | p50 (ms) | p95 (ms) | max (ms) | Sum of latencies (ms) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const c of concurrencies) {
    const s = perC[c];
    if (!s) { lines.push(`| ${c} | — | — | — | — | — | — | — |`); continue; }
    const speedup    = s.speedup !== undefined ? `${s.speedup.toFixed(2)}×` : '—';
    const efficiency = s.efficiency !== undefined ? `${(s.efficiency * 100).toFixed(1)}%` : '—';
    lines.push(`| ${c} | ${fmt(s.makespan_mean, s.makespan_stdev)} | ${speedup} | ${efficiency} | ${fmt(s.p50_mean, s.p50_stdev)} | ${fmt(s.p95_mean, s.p95_stdev)} | ${fmt(s.max_mean, s.max_stdev)} | ${fmt(s.sum_latency_mean, s.sum_latency_stdev)} |`);
  }
  lines.push('');
  lines.push('## Correctness');
  lines.push('');
  if (warnings.length === 0) {
    lines.push('✅ No warnings: violation counts identical across all trials and across all concurrency levels.');
  } else {
    lines.push('⚠ Warnings:');
    for (const w of warnings) lines.push(`- ${w}`);
  }
  fs.writeFileSync(args.md, lines.join('\n') + '\n');

  console.log(`Aggregated ${concurrencies.length} concurrency level(s) for mode '${mode}'.`);
  console.log(`  JSON: ${args.out}`);
  console.log(`  MD:   ${args.md}`);
  if (warnings.length === 0) console.log('  ✅ no correctness warnings.');
  else { console.log(`  ⚠ ${warnings.length} warning(s):`); for (const w of warnings) console.log(`    - ${w}`); }
}

main();
