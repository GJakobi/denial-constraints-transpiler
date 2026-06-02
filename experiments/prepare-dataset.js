#!/usr/bin/env node
/**
 * prepare-dataset.js
 *
 * Converts a DCValidity-style CSV (header: "colname(Type),...") to the format
 * expected by FACET (header: "COLNAME TYPE,...").
 *
 * DCValidity type annotations → FACET types:
 *   (String)  → STR
 *   (Integer) → INT
 *   (Long)    → INT
 *   (Double)  → FLOAT
 *   (Float)   → FLOAT
 *
 * Data rows are written unchanged.
 *
 * Usage:
 *   node experiments/prepare-dataset.js <input.csv> <output.csv>
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const [inputFile, outputFile] = process.argv.slice(2);

if (!inputFile || !outputFile) {
  console.error('Usage: node prepare-dataset.js <input.csv> <output.csv>');
  process.exit(1);
}

const TYPE_MAP = {
  string:  'STR',
  str:     'STR',
  integer: 'INT',
  int:     'INT',
  long:    'INT',
  double:  'FLOAT',
  float:   'FLOAT',
};

/**
 * Convert a single header cell like "colname(Type)" to "COLNAME TYPE".
 * If there is no type annotation (plain CSV), infer STR as fallback.
 */
/**
 * Sanitize a column name to a single FACET-safe token: uppercase, with any
 * non-alphanumeric character (including spaces) replaced by underscore.
 * This must match what `loader.ts#sanitizeIdentifier` produces for the
 * transpiler side, modulo case, so that the two pipelines reference the
 * same column on each side. (FACET parses `COLNAME TYPE` by splitting on
 * whitespace — a column name containing a space breaks the parser.)
 */
function sanitizeColName(raw) {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '_')
    .replace(/^[0-9]/, '_$&');
}

function convertHeader(cell) {
  const match = cell.trim().match(/^([^(]+)\(([^)]+)\)$/);
  if (match) {
    const colName = sanitizeColName(match[1]);
    const rawType = match[2].trim().toLowerCase();
    const facetType = TYPE_MAP[rawType];
    if (!facetType) {
      throw new Error(`Unknown type annotation "${match[2]}" in header cell "${cell}"`);
    }
    return `${colName} ${facetType}`;
  }

  // No type annotation — treat as STR
  return `${sanitizeColName(cell)} STR`;
}

const content = fs.readFileSync(inputFile, 'utf-8');
const lines   = content.split('\n');

if (lines.length === 0) {
  console.error('Input file is empty.');
  process.exit(1);
}

// Convert header row
const headerCells     = lines[0].split(',');
const convertedHeader = headerCells.map(convertHeader).join(',');

// Data rows unchanged
const outputLines = [convertedHeader, ...lines.slice(1)];

fs.mkdirSync(path.dirname(path.resolve(outputFile)), { recursive: true });
fs.writeFileSync(outputFile, outputLines.join('\n'));

console.log(`Converted: ${inputFile} → ${outputFile}`);
console.log(`Header: ${convertedHeader.slice(0, 120)}${convertedHeader.length > 120 ? '...' : ''}`);
