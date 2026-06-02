#!/usr/bin/env node
/**
 * convert-to-facet.js
 *
 * Converts a transpiler DC file to FACET CSV format.
 *
 * Transpiler format (input):
 *   ¬(t0.table.col op t1.table.col ^ ...)
 *
 * FACET format (output, one row per DC, one predicate per column):
 *   t1.COL op t2.COL,t1.COL op t2.COL,...
 *
 * Conversion rules:
 *   - t0 → t1,  t1 → t2  (FACET uses t1/t2, not t0/t1)
 *   - Column names: UPPERCASE
 *   - Table name: removed
 *   - No spaces around operator
 *   - Predicates joined by comma (CSV column separator)
 *
 * Usage:
 *   node experiments/convert-to-facet.js <input.txt> <output.csv>
 *
 * Example:
 *   node experiments/convert-to-facet.js \
 *     denial-constraints-transpiler/examples/dcs/airport.txt \
 *     experiments/results/airport/facet/all-dcs.csv
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const [inputFile, outputFile] = process.argv.slice(2);

if (!inputFile || !outputFile) {
  console.error('Usage: node convert-to-facet.js <input.txt> <output.csv>');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TID_MAP = { t0: 't1', t1: 't2' };

/**
 * Parse one expression like "t0.airport.ident" into { tid, col }.
 * The table name is discarded — FACET does not use it.
 */
function parseExpr(expr) {
  const first = expr.indexOf('.');
  const second = expr.indexOf('.', first + 1);
  if (first === -1 || second === -1) {
    throw new Error(`Cannot parse tuple expression: "${expr}"`);
  }
  return {
    tid: expr.slice(0, first),
    col: expr.slice(second + 1),
  };
}

/**
 * Convert one predicate "t0.table.col op t1.table.col"
 * to FACET format "t1.COL op t2.COL" (no spaces around op).
 */
function convertPredicate(pred) {
  const parts = pred.trim().split(/\s+/); // ['t0.table.col', 'op', 't1.table.col']
  if (parts.length !== 3) {
    throw new Error(`Unexpected predicate format: "${pred}"`);
  }

  const [leftExpr, op, rightExpr] = parts;
  const left  = parseExpr(leftExpr);
  const right = parseExpr(rightExpr);

  const leftTid  = TID_MAP[left.tid];
  const rightTid = TID_MAP[right.tid];

  if (!leftTid || !rightTid) {
    throw new Error(`Unknown tuple ID in predicate: "${pred}"`);
  }

  // FACET uses no spaces around the operator
  return `${leftTid}.${left.col.toUpperCase()}${op}${rightTid}.${right.col.toUpperCase()}`;
}

/**
 * Convert one DC line "¬(t0.table.col op t1.table.col ^ ...)"
 * to a FACET CSV row "t1.COL op t2.COL,t1.COL op t2.COL,...".
 */
function convertDC(line) {
  // Strip ¬( ... )
  const inner = line.replace(/^¬\(/, '').replace(/\)$/, '');
  // Split predicates on " ^ " (with surrounding spaces)
  const predicates = inner.split(/\s+\^\s+/);
  return predicates.map(convertPredicate).join(',');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const lines = fs.readFileSync(inputFile, 'utf-8')
  .split('\n')
  .map(l => l.trim())
  .filter(l => l.length > 0 && !l.startsWith('#'));

const csvRows = [];
const errors  = [];

for (let i = 0; i < lines.length; i++) {
  try {
    csvRows.push(convertDC(lines[i]));
  } catch (err) {
    errors.push(`DC ${i + 1}: ${err.message}`);
    csvRows.push(''); // placeholder to keep line numbers aligned
  }
}

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(outputFile, csvRows.join('\n') + '\n');

console.log(`Converted ${csvRows.length} DCs → ${outputFile}`);
if (errors.length > 0) {
  console.error(`\nWarnings (${errors.length}):`);
  errors.forEach(e => console.error('  ' + e));
}
