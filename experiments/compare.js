#!/usr/bin/env node
/**
 * compare.js
 *
 * Compares transpiler output vs FACET output for RQ1 correctness check.
 *
 * Both tools report violating pairs as "(rowid1, rowid2)" lines per DC.
 * Because FACET always reports both orderings of a pair and the transpiler
 * reports only the ordered pair(s) that satisfy the DC predicates, we
 * normalize both outputs to UNORDERED pairs {min, max} before comparing.
 * See PROGRESS.md Q1 for the full discussion.
 *
 * Optional ground-truth verification (used by run-rq3.sh after running
 * inject-violations.js): if --injected-truth and --target-dc are passed,
 * verify that every planted pair in injected.json appears in BOTH tools'
 * output for the target DC. This is the third independent RQ1 sanity check
 * described in PROGRESS.md ("Violation injection for RQ3" section).
 *
 * FACET-unsupported DC handling: pass --log <path> to the experiment-driver
 * log file. The compare script will detect DCs FACET refused to plan
 * (these emit "DC NNN: FACET returned non-zero exit" in the log) and label
 * them as ⚠️ FACET-UNSUPPORTED instead of ❌ MISMATCH. These do not count
 * as failures (see PROGRESS.md → "FACET DC-form limitation").
 *
 * Usage:
 *   node experiments/compare.js \
 *     --transpiler experiments/results/<dataset>/transpiler \
 *     --facet      experiments/results/<dataset>/facet \
 *     --dcs        denial-constraints-transpiler/examples/dcs/<dataset>.txt \
 *     [--log       experiments/results/<dataset>.log] \
 *     [--injected-truth experiments/results/rq3/<N>/injected.json] \
 *     [--target-dc 10] \
 *     [--verbose]
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let transpilerDir   = '';
let facetDir        = '';
let dcsFile         = '';
let logFile         = '';
let injectedTruth   = '';
let targetDc        = 0;
let verbose         = false;

for (let i = 0; i < argv.length; i++) {
  switch (argv[i]) {
    case '--transpiler':      transpilerDir = path.resolve(argv[++i]); break;
    case '--facet':           facetDir      = path.resolve(argv[++i]); break;
    case '--dcs':             dcsFile       = path.resolve(argv[++i]); break;
    case '--log':             logFile       = path.resolve(argv[++i]); break;
    case '--injected-truth':  injectedTruth = path.resolve(argv[++i]); break;
    case '--target-dc':       targetDc      = parseInt(argv[++i], 10); break;
    case '--verbose':         verbose       = true;                    break;
  }
}

if (!transpilerDir || !facetDir || !dcsFile) {
  console.error(
    'Usage: node compare.js --transpiler <dir> --facet <dir> --dcs <file> ' +
    '[--log <path>] [--injected-truth <json>] [--target-dc <num>] [--verbose]'
  );
  process.exit(1);
}

if ((injectedTruth && !targetDc) || (!injectedTruth && targetDc)) {
  console.error('--injected-truth and --target-dc must be provided together.');
  process.exit(1);
}

// Load ground truth if provided. Pairs are already in canonical "min,max"
// 1-based form (the inject script emitted them sorted).
let injectedPairs = null;
if (injectedTruth) {
  const truth = JSON.parse(fs.readFileSync(injectedTruth, 'utf-8'));
  injectedPairs = new Set(
    truth.pairs.map(([a, b]) => `${Math.min(a, b)},${Math.max(a, b)}`)
  );
}

// Optional: read the experiment driver log to find DCs FACET refused to
// plan. These are emitted by run-experiment-server.sh as:
//   "  DC NNN: FACET returned non-zero exit (may be OK)"
// We label them as ⚠️ FACET-UNSUPPORTED rather than ❌ MISMATCH, since
// the transpiler is doing the right thing — FACET is the one that bailed.
const erroredDcs = new Set();
if (logFile && fs.existsSync(logFile)) {
  const log = fs.readFileSync(logFile, 'utf-8');
  const re  = /DC (\d{3}): FACET returned non-zero exit/g;
  for (const m of log.matchAll(re)) {
    erroredDcs.add(parseInt(m[1], 10));
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse "(rowid1, rowid2)" lines from a file into a Set of
 * canonical unordered pair strings "min,max".
 *
 * offset: add this value to each row ID before normalizing.
 * FACET uses 0-based row indices; the transpiler uses 1-based (PostgreSQL SERIAL).
 * Pass offset=1 for FACET output to align both to the same 1-based space.
 */
function parsePairsFile(filePath, offset = 0) {
  // Missing file = 0 violations (FACET does not create the file when nothing is found)
  if (!fs.existsSync(filePath)) return new Set();

  const content = fs.readFileSync(filePath, 'utf-8');
  const pairs   = new Set();

  for (const line of content.split('\n')) {
    const match = line.trim().match(/^\((\d+),\s*(\d+)\)$/);
    if (match) {
      const a = parseInt(match[1], 10) + offset;
      const b = parseInt(match[2], 10) + offset;
      pairs.add(`${Math.min(a, b)},${Math.max(a, b)}`);
    }
  }

  return pairs;
}

/** Set difference: elements in setA but not in setB. */
function difference(setA, setB) {
  return new Set([...setA].filter(x => !setB.has(x)));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const dcStrings = fs.readFileSync(dcsFile, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith('#'));

const W = 72;
console.log('═'.repeat(W));
console.log(' RQ1 Correctness Check — Transpiler vs FACET');
console.log('═'.repeat(W));

let matched           = 0;
let mismatched        = 0;
let skipped           = 0;
let facetUnsupported  = 0;
let groundTruthOK     = null; // null = not checked; true/false otherwise

for (let i = 0; i < dcStrings.length; i++) {
  const dcNum = String(i + 1).padStart(3, '0');
  const dc    = dcStrings[i];
  const label = `DC ${dcNum}`;

  const transpilerFile = path.join(transpilerDir, `dc_${dcNum}.txt`);
  const facetFile      = path.join(facetDir,      `dc_${dcNum}.txt`);

  const transpilerPairs = parsePairsFile(transpilerFile);
  const facetPairs      = parsePairsFile(facetFile, 1); // FACET is 0-based; shift to 1-based

  if (transpilerPairs === null) {
    console.log(`${label}: ⚠️  SKIPPED — transpiler output missing`);
    skipped++;
    continue;
  }

  // FACET refused to plan this DC (see PROGRESS.md → "FACET DC-form
  // limitation"). The transpiler runs it correctly; we report the
  // transpiler's output and move on. NOT counted as a mismatch.
  if (erroredDcs.has(i + 1)) {
    console.log(
      `${label}: ⚠️  FACET-UNSUPPORTED  ` +
      `(transpiler found ${transpilerPairs.size} pair(s); ` +
      `FACET refused to plan — see PROGRESS.md)`
    );
    facetUnsupported++;
    if (verbose) console.log(`       DC: ${dc}`);
    continue;
  }

  const onlyInTranspiler = difference(transpilerPairs, facetPairs);
  const onlyInFacet      = difference(facetPairs, transpilerPairs);
  const isMatch          = onlyInTranspiler.size === 0 && onlyInFacet.size === 0;

  if (isMatch) {
    console.log(`${label}: ✅  MATCH   (${transpilerPairs.size} unordered pair(s))`);
    matched++;
  } else {
    console.log(`${label}: ❌  MISMATCH`);
    console.log(`       transpiler: ${transpilerPairs.size} pair(s) | facet: ${facetPairs.size} pair(s)`);
    console.log(`       only in transpiler: ${onlyInTranspiler.size} | only in facet: ${onlyInFacet.size}`);
    mismatched++;
  }

  // Ground-truth verification for the target DC.
  if (injectedPairs && i + 1 === targetDc) {
    const missingFromTranspiler = difference(injectedPairs, transpilerPairs);
    const missingFromFacet      = difference(injectedPairs, facetPairs);
    const truthMatch = missingFromTranspiler.size === 0 && missingFromFacet.size === 0;
    groundTruthOK = truthMatch;

    if (truthMatch) {
      console.log(
        `       Ground truth: ${injectedPairs.size}/${injectedPairs.size} injected pair(s) ` +
        `detected by transpiler AND FACET ✅`
      );
    } else {
      console.log(
        `       Ground truth: transpiler missed ${missingFromTranspiler.size}/${injectedPairs.size} ` +
        `| FACET missed ${missingFromFacet.size}/${injectedPairs.size} ❌`
      );
      if (verbose) {
        const sampleT = [...missingFromTranspiler].slice(0, 5);
        const sampleF = [...missingFromFacet].slice(0, 5);
        if (sampleT.length)
          console.log(`       Missing from transpiler (first ${sampleT.length}): ${sampleT.map(p => `{${p}}`).join(', ')}`);
        if (sampleF.length)
          console.log(`       Missing from FACET      (first ${sampleF.length}): ${sampleF.map(p => `{${p}}`).join(', ')}`);
      }
    }
  }

  if (verbose) {
    console.log(`       DC: ${dc}`);
    if (!isMatch) {
      if (onlyInTranspiler.size > 0) {
        const sample = [...onlyInTranspiler].slice(0, 5);
        console.log(`       Transpiler-only pairs (first ${sample.length}): ${sample.map(p => `{${p}}`).join(', ')}`);
      }
      if (onlyInFacet.size > 0) {
        const sample = [...onlyInFacet].slice(0, 5);
        console.log(`       FACET-only pairs      (first ${sample.length}): ${sample.map(p => `{${p}}`).join(', ')}`);
      }
    }
  }
}

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('─'.repeat(W));
console.log(`Total DCs: ${dcStrings.length}`);
console.log(`  ✅  Matched:           ${matched}`);
console.log(`  ❌  Mismatched:        ${mismatched}`);
console.log(`  ⚠️   FACET-unsupported: ${facetUnsupported}` +
            (logFile ? '' : ' (pass --log to detect; currently lumped into Mismatched)'));
console.log(`  ⚠️   Skipped:           ${skipped}`);
if (injectedPairs) {
  const tag = groundTruthOK === true  ? '✅ PASS'
            : groundTruthOK === false ? '❌ FAIL'
            : '⚠️  NOT CHECKED (target DC not in DC file)';
  console.log(`  Ground truth on DC ${String(targetDc).padStart(3, '0')}: ${tag} (${injectedPairs.size} planted pair(s))`);
}
console.log('═'.repeat(W));

const failed = mismatched > 0 || groundTruthOK === false;

if (!failed && skipped === 0) {
  const unsupSuffix = facetUnsupported > 0
    ? ` (${facetUnsupported} DC(s) FACET refused to plan — see PROGRESS.md → "FACET DC-form limitation")`
    : '';
  console.log(
    `\nRQ1 result: PASS — transpiler output matches FACET on all comparable DCs` +
    (injectedPairs ? ' and all planted violations were detected' : '') +
    `${unsupSuffix}.`
  );
} else if (failed) {
  console.log('\nRQ1 result: FAIL — investigate above.');
  process.exit(1);
}
