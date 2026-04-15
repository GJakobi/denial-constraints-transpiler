/**
 * run-pairs.ts
 *
 * Experiment runner: executes each DC and writes violating pairs to individual
 * files in machine-readable format for comparison with FACET (RQ1).
 *
 * Output per DC: one file dc_NNN.txt with one "(rowid, rowid)" line per violation.
 * Summary: summary.json with DC string, violation count, and execution time.
 *
 * Usage:
 *   npx ts-node src/run-pairs.ts \
 *     --csv   data/datasets/airport.csv \
 *     --table airport \
 *     --dcs   examples/dcs/airport.txt \
 *     --out   /path/to/output/dir \
 *     [--host localhost] [--port 5432] [--db dctest] [--user postgres] [--pass ""]
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { loadCSV } from './loader';
import { DCParser } from './parser';
import { DCTranspiler } from './transpiler';
import { DBConfig } from './types';

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface Args {
  csv?: string;
  table?: string;
  dcsFile?: string;
  outDir: string;
  dbConfig: DBConfig;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    outDir: 'results',
    dbConfig: {
      host: process.env.PGHOST ?? 'localhost',
      port: parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'dctest',
      user: process.env.PGUSER ?? 'postgres',
      password: process.env.PGPASSWORD ?? '',
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    switch (flag) {
      case '--csv':   args.csv   = path.resolve(next); i++; break;
      case '--table': args.table = next;                i++; break;
      case '--dcs':   args.dcsFile = path.resolve(next); i++; break;
      case '--out':   args.outDir  = path.resolve(next); i++; break;
      case '--host':  args.dbConfig.host     = next;              i++; break;
      case '--port':  args.dbConfig.port     = parseInt(next, 10); i++; break;
      case '--db':    args.dbConfig.database = next;              i++; break;
      case '--user':  args.dbConfig.user     = next;              i++; break;
      case '--pass':  args.dbConfig.password = next;              i++; break;
    }
  }

  return args;
}

// ─── SQL builder ──────────────────────────────────────────────────────────────

/**
 * Transpile a DC string into a SQL query that returns only
 * (t0._row_id, t1._row_id) pairs — avoids column name collisions
 * from SELECT t0.*, t1.* and keeps result rows lightweight.
 */
function buildPairsSQL(dcStr: string, parser: DCParser, transpiler: DCTranspiler): string {
  const dc = parser.parse(dcStr);
  parser.validate(dc);

  // Get the single-line SQL from the transpiler
  const fullSql = transpiler.transpile(dc);

  // Extract FROM and WHERE clauses from:
  //   SELECT <cols> FROM <from> WHERE <conditions>;
  const fromIdx   = fullSql.indexOf(' FROM ');
  const whereIdx  = fullSql.indexOf(' WHERE ');

  if (fromIdx === -1 || whereIdx === -1) {
    throw new Error(`Cannot parse transpiled SQL: ${fullSql}`);
  }

  const fromClause  = fullSql.slice(fromIdx + 6, whereIdx);
  const whereClause = fullSql.slice(whereIdx + 7).replace(/;$/, '');

  return `SELECT t0._row_id AS t0_row_id, t1._row_id AS t1_row_id FROM ${fromClause} WHERE ${whereClause};`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface SummaryEntry {
  dc_num: number;
  dc: string;
  violations: number;
  time_ms: number;
  file: string;
  error?: string;
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(args.outDir, { recursive: true });

  // ── 1. Load CSV into PostgreSQL ───────────────────────────────────────────
  if (args.csv) {
    if (!args.table) {
      console.error('Error: --table is required when --csv is provided.');
      process.exit(1);
    }
    console.log(`Loading CSV: ${args.csv} → table "${args.table}"`);
    const client = new Client(args.dbConfig);
    await client.connect();
    try {
      await loadCSV(client, args.csv, args.table, { dropIfExists: true });
    } finally {
      await client.end();
    }
  }

  // ── 2. Read DC strings from file ──────────────────────────────────────────
  if (!args.dcsFile) {
    console.error('Error: --dcs <file> is required.');
    process.exit(1);
  }

  const dcStrings = fs.readFileSync(args.dcsFile, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  console.log(`\nRunning ${dcStrings.length} DCs → output in ${args.outDir}\n`);

  // ── 3. Run each DC ────────────────────────────────────────────────────────
  const parser     = new DCParser();
  const transpiler = new DCTranspiler({ formatOutput: false, selectAllColumns: false });
  const summary: SummaryEntry[] = [];

  for (let i = 0; i < dcStrings.length; i++) {
    const dcStr  = dcStrings[i];
    const dcNum  = String(i + 1).padStart(3, '0');
    const outFile = path.join(args.outDir, `dc_${dcNum}.txt`);

    try {
      const sql = buildPairsSQL(dcStr, parser, transpiler);

      const client = new Client(args.dbConfig);
      await client.connect();
      const t0 = Date.now();
      let rows: { t0_row_id: number; t1_row_id: number }[] = [];
      try {
        const result = await client.query(sql);
        rows = result.rows as { t0_row_id: number; t1_row_id: number }[];
      } finally {
        await client.end();
      }
      const elapsed = Date.now() - t0;

      // Write "(rowid, rowid)" per line — same format as FACET output
      const lines = rows.map(r => `(${r.t0_row_id}, ${r.t1_row_id})`);
      fs.writeFileSync(outFile, lines.join('\n') + (lines.length > 0 ? '\n' : ''));

      summary.push({ dc_num: i + 1, dc: dcStr, violations: rows.length, time_ms: elapsed, file: path.basename(outFile) });
      console.log(`DC ${dcNum}: ${rows.length} violation(s)  [${elapsed} ms]  → ${path.basename(outFile)}`);

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`DC ${dcNum} ERROR: ${msg}`);
      fs.writeFileSync(outFile, '');
      summary.push({ dc_num: i + 1, dc: dcStr, violations: -1, time_ms: 0, file: path.basename(outFile), error: msg });
    }
  }

  // ── 4. Write summary ──────────────────────────────────────────────────────
  const summaryFile = path.join(args.outDir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  const totalViolations = summary.reduce((acc, e) => acc + Math.max(e.violations, 0), 0);
  const totalTime       = summary.reduce((acc, e) => acc + e.time_ms, 0);
  const errors          = summary.filter(e => e.error).length;

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Done. ${dcStrings.length} DCs | ${totalViolations} violations | ${totalTime} ms total | ${errors} error(s)`);
  console.log(`Summary: ${summaryFile}`);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
