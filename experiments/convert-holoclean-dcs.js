#!/usr/bin/env node
/**
 * convert-holoclean-dcs.js
 *
 * Converts the HoloClean DC syntax used in `hospital_constraints.txt` to the
 * transpiler's textual notation.
 *
 * HoloClean syntax (one DC per line):
 *   t1&t2&EQ(t1.X,t2.X)&IQ(t1.Y,t2.Y)&...
 *
 *   - `t1`, `t2`             tuple variables (header tokens, kept literal)
 *   - `EQ(t1.X,t2.X)`        equality predicate on column X
 *   - `IQ(t1.X,t2.X)`        inequality predicate on column X
 *   - `&`                    predicate separator (logical AND inside the DC body)
 *
 * Transpiler syntax (one DC per line):
 *   ¬(t0.<table>.<col> == t1.<table>.<col> ^ t0.<table>.<col> <> t1.<table>.<col> ...)
 *
 * Conversion rules:
 *   - Variable rename:  t1 → t0,   t2 → t1   (HoloClean uses 1-indexed, transpiler uses 0-indexed)
 *   - Operator map:     EQ → ==,  IQ → <>
 *   - Predicate join:   &  → ^
 *   - Column names sanitized to match loader.ts#sanitizeIdentifier
 *     (lowercase, non-alphanumeric → underscore).
 *   - Table name injected (CLI arg).
 *   - Wrap result in ¬( ... ).
 *
 * Source: HoloClean (Rekatsinas et al., VLDB 2017),
 *   https://github.com/HoloClean/holoclean/blob/master/testdata/hospital_constraints.txt
 *
 * Usage:
 *   node experiments/convert-holoclean-dcs.js <input.txt> <table-name> <output.txt>
 *
 * Example:
 *   node experiments/convert-holoclean-dcs.js \
 *     /tmp/hospital_constraints.txt \
 *     hospital \
 *     denial-constraints-transpiler/examples/dcs/hospital.txt
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─── CLI args ─────────────────────────────────────────────────────────────────

const [inputFile, tableName, outputFile] = process.argv.slice(2);

if (!inputFile || !tableName || !outputFile) {
  console.error('Usage: node convert-holoclean-dcs.js <input.txt> <table-name> <output.txt>');
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TID_MAP = { t1: 't0', t2: 't1' };

/**
 * Sanitize a column name to match loader.ts#sanitizeIdentifier on the
 * transpiler side: lowercase, non-alphanumeric → underscore, leading digit → underscored.
 */
function sanitizeColName(raw) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/^[0-9]/, '_$&');
}

/**
 * Convert one HoloClean predicate to the transpiler textual form.
 *   "EQ(t1.X,t2.X)" → "t0.<table>.x == t1.<table>.x"
 *   "IQ(t1.X,t2.Y)" → "t0.<table>.x <> t1.<table>.y"
 */
function convertPredicate(pred, table) {
  const match = pred.match(/^(EQ|IQ)\(([^,]+),([^)]+)\)$/);
  if (!match) {
    throw new Error(`Unrecognized HoloClean predicate: "${pred}"`);
  }
  const [, op, leftTok, rightTok] = match;

  // Each token is "tN.ColumnName"
  const parseTok = (tok) => {
    const dot = tok.indexOf('.');
    if (dot < 0) throw new Error(`Expected "tN.col", got "${tok}"`);
    const rawTid = tok.slice(0, dot).trim();
    const rawCol = tok.slice(dot + 1).trim();
    const tid = TID_MAP[rawTid];
    if (!tid) throw new Error(`Unknown tuple variable "${rawTid}" in predicate "${pred}"`);
    return { tid, col: sanitizeColName(rawCol) };
  };

  const left  = parseTok(leftTok);
  const right = parseTok(rightTok);
  const sqlOp = op === 'EQ' ? '==' : '<>';

  return `${left.tid}.${table}.${left.col} ${sqlOp} ${right.tid}.${table}.${right.col}`;
}

/**
 * Convert one HoloClean DC line ("t1&t2&EQ(...)&IQ(...)") to the transpiler
 * textual form ("¬(... ^ ... ^ ...)").
 */
function convertDC(line, table) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;

  // Split on `&`; expect first two tokens to be the tuple-variable header (t1, t2).
  const tokens = trimmed.split('&');
  if (tokens.length < 3) {
    throw new Error(`Line has fewer than 3 &-separated tokens: "${line}"`);
  }
  if (tokens[0] !== 't1' || tokens[1] !== 't2') {
    throw new Error(`Expected header "t1&t2&...", got "${tokens.slice(0, 2).join('&')}"`);
  }

  const predicates = tokens.slice(2).map((p) => convertPredicate(p, table));
  return `¬(${predicates.join(' ^ ')})`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const lines = fs.readFileSync(inputFile, 'utf-8').split('\n');
const converted = [];
const errors    = [];

for (let i = 0; i < lines.length; i++) {
  try {
    const result = convertDC(lines[i], tableName);
    if (result !== null) converted.push(result);
  } catch (err) {
    errors.push(`Line ${i + 1}: ${err.message}`);
  }
}

const header = [
  `# Denial Constraints for dataset: ${tableName}`,
  `# Source: HoloClean (Rekatsinas et al., VLDB 2017)`,
  `#   https://github.com/HoloClean/holoclean/blob/master/testdata/hospital_constraints.txt`,
  `# Original syntax: t1&t2&EQ(...)&IQ(...)`,
  `# Converted to: ¬(t0.${tableName}.col op t1.${tableName}.col ^ ...)`,
  ``,
].join('\n');

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(outputFile, header + converted.join('\n') + '\n');

console.log(`Converted ${converted.length} DCs → ${outputFile}`);
if (errors.length > 0) {
  console.error(`\nWarnings (${errors.length}):`);
  errors.forEach((e) => console.error('  ' + e));
  process.exit(1);
}
