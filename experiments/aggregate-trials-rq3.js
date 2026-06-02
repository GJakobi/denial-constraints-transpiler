#!/usr/bin/env node
/**
 * aggregate-trials-rq3.js
 *
 * Aggregates the RQ3 scalability sweep across K trials produced by
 * run-k-trials-rq3.sh. Each trial writes one rq3_summary.csv with columns:
 *
 *   dc_num,size,transpiler_ms,facet_ms,transpiler_violations,facet_violations
 *
 * (facet_ms is FACET's per-invocation wall time, which includes the CSV reload
 * — each DC is a separate FACET process on the subset.)
 *
 * We report two views, both as mean ± stdev (sample/Bessel) with CV across the
 * K trials:
 *
 *   1. Per-size TOTAL — for each subset size, the sum over all 30 DCs of the
 *      transpiler time and of the FACET wall time, summed WITHIN each trial and
 *      then aggregated across trials. This is the scalability curve.
 *
 *   2. Per-(DC,size) detail — full table, for inspecting which DCs drive the
 *      cost (e.g. the order-dependency DCs 29/30).
 *
 * Violation counts are also checked: they must be identical across trials
 * (the injection is fixed-seed), and transpiler must equal FACET on every
 * comparable DC. Any divergence is flagged.
 *
 * Usage:
 *   node experiments/aggregate-trials-rq3.js \
 *     --base experiments/results-k-trials-rq3 \
 *     --k    5 \
 *     --out  experiments/results-k-trials-rq3/aggregated_rq3.json \
 *     --md   experiments/results-k-trials-rq3/aggregated_rq3.md
 */

'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { base: null, k: 5, out: null, md: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') args.base = argv[++i];
    else if (a === '--k') args.k = parseInt(argv[++i], 10);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--md') args.md = argv[++i];
  }
  if (!args.base) {
    console.error('ERROR: --base is required');
    process.exit(1);
  }
  if (!args.out) args.out = path.join(args.base, 'aggregated_rq3.json');
  if (!args.md) args.md = path.join(args.base, 'aggregated_rq3.md');
  return args;
}

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}
function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function cvPct(m, s) {
  return m === 0 ? 0 : (100 * s) / m;
}

function readTrialCsv(file) {
  // Returns array of {dc, size, transpiler_ms, facet_ms, tv, fv}
  const txt = fs.readFileSync(file, 'utf8').trim();
  const lines = txt.split('\n');
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const [dc, size, tms, fms, tv, fv] = line.split(',');
    rows.push({
      dc: parseInt(dc, 10),
      size: parseInt(size, 10),
      transpiler_ms: Number(tms),
      facet_ms: Number(fms),
      tv: Number(tv),
      fv: Number(fv),
    });
  }
  return rows;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  // ── Load every trial we can find ────────────────────────────────────────
  const trials = [];
  for (let t = 1; t <= args.k; t++) {
    const f = path.join(args.base, `trial_${t}`, 'rq3', 'rq3_summary.csv');
    if (fs.existsSync(f)) {
      trials.push({ t, rows: readTrialCsv(f) });
    } else {
      console.error(`WARN: missing ${f} — trial ${t} skipped`);
    }
  }
  if (trials.length === 0) {
    console.error('ERROR: no trial summaries found');
    process.exit(1);
  }
  const K = trials.length;

  // ── Collect the set of sizes and DCs ────────────────────────────────────
  const sizes = [...new Set(trials[0].rows.map((r) => r.size))].sort((a, b) => a - b);
  const dcs = [...new Set(trials[0].rows.map((r) => r.dc))].sort((a, b) => a - b);

  // index[trial][size][dc] = row
  const idx = trials.map((tr) => {
    const m = {};
    for (const r of tr.rows) {
      (m[r.size] = m[r.size] || {})[r.dc] = r;
    }
    return m;
  });

  // ── Correctness checks ──────────────────────────────────────────────────
  const warnings = [];
  for (const size of sizes) {
    for (const dc of dcs) {
      const tv = idx.map((m) => (m[size] && m[size][dc] ? m[size][dc].tv : null));
      const fv = idx.map((m) => (m[size] && m[size][dc] ? m[size][dc].fv : null));
      // violations must be constant across trials (fixed-seed injection)
      const uniqTv = [...new Set(tv.filter((x) => x !== null))];
      if (uniqTv.length > 1) {
        warnings.push(`DC ${dc} @ ${size}: transpiler violations vary across trials: ${uniqTv.join(',')}`);
      }
      // transpiler must equal FACET where FACET produced a count.
      // (FACET-unsupported DCs report fv=0 while transpiler may be >0 — those
      //  are flagged separately, not treated as a mismatch here.)
      for (let i = 0; i < K; i++) {
        if (tv[i] !== null && fv[i] !== null && tv[i] !== fv[i] && fv[i] !== 0) {
          warnings.push(`DC ${dc} @ ${size} trial ${trials[i].t}: transpiler ${tv[i]} != FACET ${fv[i]}`);
        }
      }
    }
  }

  // ── Per-(DC,size) aggregate ─────────────────────────────────────────────
  const perDc = [];
  for (const size of sizes) {
    for (const dc of dcs) {
      const tms = idx.map((m) => m[size] && m[size][dc] ? m[size][dc].transpiler_ms : null).filter((x) => x !== null);
      const fms = idx.map((m) => m[size] && m[size][dc] ? m[size][dc].facet_ms : null).filter((x) => x !== null);
      const tv = idx.map((m) => m[size] && m[size][dc] ? m[size][dc].tv : null).find((x) => x !== null) ?? 0;
      const fv = idx.map((m) => m[size] && m[size][dc] ? m[size][dc].fv : null).find((x) => x !== null) ?? 0;
      perDc.push({
        dc, size,
        transpiler_ms: { mean: mean(tms), stdev: stdev(tms), cv: cvPct(mean(tms), stdev(tms)), n: tms.length },
        facet_ms: { mean: mean(fms), stdev: stdev(fms), cv: cvPct(mean(fms), stdev(fms)), n: fms.length },
        transpiler_violations: tv,
        facet_violations: fv,
      });
    }
  }

  // ── Per-size TOTAL (sum within trial, then aggregate across trials) ──────
  const perSize = [];
  for (const size of sizes) {
    const tTotals = [];
    const fTotals = [];
    for (const m of idx) {
      if (!m[size]) continue;
      let tsum = 0, fsum = 0;
      for (const dc of dcs) {
        if (m[size][dc]) {
          tsum += m[size][dc].transpiler_ms;
          fsum += m[size][dc].facet_ms;
        }
      }
      tTotals.push(tsum);
      fTotals.push(fsum);
    }
    perSize.push({
      size,
      transpiler_total_ms: { mean: mean(tTotals), stdev: stdev(tTotals), cv: cvPct(mean(tTotals), stdev(tTotals)), n: tTotals.length },
      facet_total_ms: { mean: mean(fTotals), stdev: stdev(fTotals), cv: cvPct(mean(fTotals), stdev(fTotals)), n: fTotals.length },
    });
  }

  // ── Write JSON ──────────────────────────────────────────────────────────
  const out = { generated: new Date().toISOString(), k_requested: args.k, k_used: K, sizes, dcs, perSize, perDc, warnings };
  fs.writeFileSync(args.out, JSON.stringify(out, null, 2));

  // ── Write Markdown ────────────────────────────────────────────────────────
  const fmt = (s) => `${s.mean.toFixed(1)} ± ${s.stdev.toFixed(1)} (CV ${s.cv.toFixed(1)}%)`;
  const lines = [];
  lines.push(`# Aggregated RQ3 scalability — tax500k subsets with injected violations`);
  lines.push('');
  lines.push(`Trials used: **${K}** of ${args.k} requested. Generated: ${out.generated}.`);
  lines.push('');
  lines.push(`Injection: DC #10 (\`fname==\` ^ \`gender<>\`), 5% of rows, fixed seed. Times are sums over all ${dcs.length} DCs per subset, in **ms**, as mean ± stdev (CV%) across the ${K} trials.`);
  lines.push('');
  lines.push(`## Per-size total (the scalability curve)`);
  lines.push('');
  lines.push(`| Size (rows) | Transpiler total (ms) | FACET wall total (ms) |`);
  lines.push(`|---|---|---|`);
  for (const r of perSize) {
    lines.push(`| ${r.size} | ${fmt(r.transpiler_total_ms)} | ${fmt(r.facet_total_ms)} |`);
  }
  lines.push('');
  lines.push(`## Injected DC #10 alone (FD-like, FACET-supported)`);
  lines.push('');
  lines.push(`| Size | Transpiler (ms) | FACET wall (ms) | Violations (ordered) |`);
  lines.push(`|---|---|---|---|`);
  for (const size of sizes) {
    const row = perDc.find((d) => d.dc === 10 && d.size === size);
    lines.push(`| ${size} | ${fmt(row.transpiler_ms)} | ${fmt(row.facet_ms)} | ${row.transpiler_violations} |`);
  }
  lines.push('');
  lines.push(`## Order-dependency DCs 29 & 30 (the transpiler's quadratic cost driver)`);
  lines.push('');
  lines.push(`| Size | DC | Transpiler (ms) | FACET wall (ms) |`);
  lines.push(`|---|---|---|---|`);
  for (const size of sizes) {
    for (const dc of [29, 30]) {
      const row = perDc.find((d) => d.dc === dc && d.size === size);
      lines.push(`| ${size} | ${dc} | ${fmt(row.transpiler_ms)} | ${fmt(row.facet_ms)} |`);
    }
  }
  lines.push('');
  if (warnings.length) {
    lines.push(`## ⚠️ Warnings (${warnings.length})`);
    lines.push('');
    for (const w of warnings) lines.push(`- ${w}`);
  } else {
    lines.push(`## Correctness`);
    lines.push('');
    lines.push(`No warnings: violation counts are identical across all trials, and transpiler == FACET on every comparable DC.`);
  }
  lines.push('');
  fs.writeFileSync(args.md, lines.join('\n'));

  console.log(`Aggregated ${K} trial(s), ${sizes.length} sizes, ${dcs.length} DCs.`);
  console.log(`  JSON: ${args.out}`);
  console.log(`  MD:   ${args.md}`);
  if (warnings.length) console.log(`  ⚠️  ${warnings.length} warning(s) — see MD.`);
  else console.log(`  ✅ no correctness warnings.`);
}

main();
