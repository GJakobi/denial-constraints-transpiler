/**
 * run-concurrent.ts
 *
 * RQ3.2 — Concurrency scalability of the transpiler.
 *
 * Submits N DC-detection queries to PostgreSQL with at most C in flight at any
 * moment, holding dataset size fixed. Measures:
 *   - makespan_ms : wall-clock time for the entire batch
 *   - per-query latencies (ms) for p50/p95/max
 *   - per-query violation counts (sanity check vs sequential baseline)
 *
 * Concurrency mechanism: a single pg.Pool with max = C. Each DC query acquires
 * a connection, runs to completion, releases. The pool queues acquisitions
 * automatically, so at any moment at most C backend processes are running our
 * queries. Promise.all over all N submissions yields the makespan.
 *
 * Per-session PG settings depend on --mode:
 *   - clean : SET max_parallel_workers_per_gather = 0   (isolate session-level
 *             concurrency from intra-query parallelism)
 *   - tuned : leave defaults (gather = 2). Caller is responsible for raising
 *             the global cap (max_parallel_workers, max_worker_processes)
 *             via postgresql.conf so intra-query parallelism is consistently
 *             available at every concurrency level. We DO NOT set the global
 *             cap from inside a session (it's PGC_POSTMASTER, immutable).
 *
 * Each (mode, concurrency) trial calls this script once; the wrapper
 * (run-k-trials-rq3-concurrent.sh) drives the (c, k) grid and warm-up policy.
 *
 * Usage:
 *   npx ts-node src/run-concurrent.ts \
 *     --csv         data/datasets/Hospital.csv \
 *     --table       Hospital \
 *     --dcs         examples/dcs/Hospital.txt \
 *     --concurrency 8 \
 *     --mode        clean \
 *     --out         /path/to/output/dir \
 *     [--limit 100000]   # row cap when loading the CSV
 *     [--warmup]         # do one discarded warm-up batch before measuring
 *     [--skip-load]      # skip the CSV load (table already present from a previous run)
 *     [--host ...] [--port ...] [--db ...] [--user ...] [--pass ...]
 */

import * as fs from 'fs';
import * as path from 'path';
import { Client, Pool, PoolClient } from 'pg';
import { loadCSV } from './loader';
import { DCParser } from './parser';
import { DCTranspiler } from './transpiler';
import { DBConfig } from './types';

// ─── Argument parsing ────────────────────────────────────────────────────────

interface Args {
  csv?: string;
  table?: string;
  dcsFile?: string;
  outDir: string;
  concurrency: number;
  mode: 'clean' | 'tuned';
  warmup: boolean;
  skipLoad: boolean;
  limit?: number;
  dbConfig: DBConfig;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    outDir: 'results',
    concurrency: 1,
    mode: 'clean',
    warmup: false,
    skipLoad: false,
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
      case '--csv':          args.csv = path.resolve(next);          i++; break;
      case '--table':        args.table = next;                      i++; break;
      case '--dcs':          args.dcsFile = path.resolve(next);      i++; break;
      case '--out':          args.outDir = path.resolve(next);       i++; break;
      case '--concurrency':  args.concurrency = parseInt(next, 10);  i++; break;
      case '--mode':
        if (next !== 'clean' && next !== 'tuned') {
          throw new Error(`--mode must be 'clean' or 'tuned', got '${next}'`);
        }
        args.mode = next;
        i++;
        break;
      case '--warmup':       args.warmup = true;                          break;
      case '--skip-load':    args.skipLoad = true;                        break;
      case '--limit':        args.limit = parseInt(next, 10);        i++; break;
      case '--host':         args.dbConfig.host = next;              i++; break;
      case '--port':         args.dbConfig.port = parseInt(next, 10); i++; break;
      case '--db':           args.dbConfig.database = next;          i++; break;
      case '--user':         args.dbConfig.user = next;              i++; break;
      case '--pass':         args.dbConfig.password = next;          i++; break;
    }
  }

  if (!args.dcsFile)                       throw new Error('--dcs <file> is required');
  if (!args.skipLoad && !args.csv)         throw new Error('--csv <file> is required unless --skip-load');
  if (!args.table)                         throw new Error('--table <name> is required');
  if (args.concurrency < 1)                throw new Error('--concurrency must be >= 1');

  return args;
}

// ─── SQL builder (mirrors run-pairs.ts) ──────────────────────────────────────

function buildPairsSQL(dcStr: string, parser: DCParser, transpiler: DCTranspiler): string {
  const dc = parser.parse(dcStr);
  parser.validate(dc);
  const fullSql = transpiler.transpile(dc);
  const fromIdx = fullSql.indexOf(' FROM ');
  const whereIdx = fullSql.indexOf(' WHERE ');
  if (fromIdx === -1 || whereIdx === -1) {
    throw new Error(`Cannot parse transpiled SQL: ${fullSql}`);
  }
  const fromClause = fullSql.slice(fromIdx + 6, whereIdx);
  const whereClause = fullSql.slice(whereIdx + 7).replace(/;$/, '');
  return `SELECT t0._row_id AS t0_row_id, t1._row_id AS t1_row_id FROM ${fromClause} WHERE ${whereClause};`;
}

// ─── Per-query execution ─────────────────────────────────────────────────────

interface QueryResult {
  dc_num: number;
  start_us: number;     // microseconds since batch start
  end_us: number;
  latency_ms: number;
  violations: number;
  error?: string;
}

async function runOne(
  pool: Pool,
  dcNum: number,
  sql: string,
  _mode: 'clean' | 'tuned',
  batchStartNs: bigint,
): Promise<QueryResult> {
  // NB: per-session settings (max_parallel_workers_per_gather) are installed
  // once per physical connection by the pool.on('connect') handler in main().
  // SET LOCAL would not work here because each client.query() runs in its own
  // implicit transaction and SET LOCAL's scope is the current transaction.
  const tBeforeAcquire = process.hrtime.bigint();
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    const tStart = process.hrtime.bigint();
    const result = await client.query(sql);
    const tEnd = process.hrtime.bigint();
    return {
      dc_num: dcNum,
      start_us: Number((tStart - batchStartNs) / BigInt(1000)),
      end_us:   Number((tEnd   - batchStartNs) / BigInt(1000)),
      latency_ms: Number(tEnd - tStart) / 1e6,
      violations: result.rows.length,
    };
  } catch (err: unknown) {
    const tEnd = process.hrtime.bigint();
    return {
      dc_num: dcNum,
      start_us: Number((tBeforeAcquire - batchStartNs) / BigInt(1000)),
      end_us:   Number((tEnd            - batchStartNs) / BigInt(1000)),
      latency_ms: Number(tEnd - tBeforeAcquire) / 1e6,
      violations: -1,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (client) client.release();
  }
}

// ─── Batch execution ─────────────────────────────────────────────────────────

interface BatchResult {
  makespan_ms: number;
  per_query: QueryResult[];
}

async function runBatch(
  pool: Pool,
  queries: { dc_num: number; sql: string }[],
  mode: 'clean' | 'tuned',
): Promise<BatchResult> {
  const batchStartNs = process.hrtime.bigint();
  // Submit all queries at once. The pool queues acquisitions when it has c
  // active connections, so at any moment ≤ c queries are running. Promise.all
  // waits until all queries (including those queued) complete.
  const per_query = await Promise.all(
    queries.map(q => runOne(pool, q.dc_num, q.sql, mode, batchStartNs)),
  );
  const batchEndNs = process.hrtime.bigint();
  return {
    makespan_ms: Number(batchEndNs - batchStartNs) / 1e6,
    per_query,
  };
}

// ─── Percentile helper ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (rank - lo) * (sorted[hi] - sorted[lo]);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  fs.mkdirSync(args.outDir, { recursive: true });

  // 1. Load CSV (single dedicated connection so the pool stays cold for measurement)
  if (!args.skipLoad && args.csv) {
    console.log(`Loading CSV: ${args.csv} → table "${args.table}" (limit=${args.limit ?? 'all'})`);
    const loader = new Client(args.dbConfig);
    await loader.connect();
    try {
      await loadCSV(loader, args.csv, args.table!, { dropIfExists: true, limit: args.limit });
    } finally {
      await loader.end();
    }
  } else {
    console.log(`Skipping CSV load; assuming table "${args.table}" already exists.`);
  }

  // 2. Build SQL for all DCs in-process (no PG, no latency in the measurement)
  const dcStrings = fs.readFileSync(args.dcsFile!, 'utf-8')
    .split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  const parser = new DCParser();
  const transpiler = new DCTranspiler({ formatOutput: false, selectAllColumns: false });
  const queries: { dc_num: number; sql: string }[] = [];
  for (let i = 0; i < dcStrings.length; i++) {
    try {
      queries.push({ dc_num: i + 1, sql: buildPairsSQL(dcStrings[i], parser, transpiler) });
    } catch (err) {
      console.error(`DC ${i + 1} build error (will be skipped): ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`Built SQL for ${queries.length} of ${dcStrings.length} DCs.`);
  console.log(`Concurrency: ${args.concurrency}    Mode: ${args.mode}    Warm-up: ${args.warmup}`);

  // 3. Create the pool with max = c. min = c forces all c connections to be
  // pre-established before the timed batch, so the makespan doesn't include
  // TCP+auth setup latency.
  const pool = new Pool({
    ...args.dbConfig,
    max: args.concurrency,
    min: args.concurrency,
    // The pool holds each backend for the full experiment; bump the idle
    // timeout high so PG doesn't reap them between warm-up and measured runs.
    idleTimeoutMillis: 0,
    allowExitOnIdle: false,
  });

  // Install per-physical-connection PG settings. This fires once per backend
  // process the pool creates. Critical for --mode clean.
  pool.on('connect', async (client) => {
    if (args.mode === 'clean') {
      await client.query('SET max_parallel_workers_per_gather = 0');
    }
    // tuned mode: leave defaults; the global cap is raised in postgresql.conf
    // by the wrapper before this script is called.
  });

  // Warm the pool: open all c connections proactively, AND verify the settings
  // were installed correctly on every backend (sanity check against silent
  // failure of the on('connect') handler).
  const verifyClients = await Promise.all(
    Array.from({ length: args.concurrency }, () => pool.connect()),
  );
  for (const c of verifyClients) {
    const r = await c.query('SHOW max_parallel_workers_per_gather');
    const v = r.rows[0].max_parallel_workers_per_gather;
    const expected = args.mode === 'clean' ? '0' : '2';
    if (v !== expected) {
      throw new Error(`Setting verification failed: max_parallel_workers_per_gather='${v}' (expected '${expected}' for mode=${args.mode})`);
    }
  }
  for (const c of verifyClients) c.release();
  console.log(`Verified max_parallel_workers_per_gather on all ${args.concurrency} backend(s).`);

  // 4. Optional warm-up batch (results discarded). Same workload, same c.
  if (args.warmup) {
    console.log(`Warm-up batch starting…`);
    const wu = await runBatch(pool, queries, args.mode);
    console.log(`Warm-up batch done in ${wu.makespan_ms.toFixed(1)} ms (discarded).`);
  }

  // 5. Measured batch.
  console.log(`Measured batch starting…`);
  const result = await runBatch(pool, queries, args.mode);

  // 6. Stats.
  const ok = result.per_query.filter(q => !q.error);
  const errored = result.per_query.length - ok.length;
  const latencies = ok.map(q => q.latency_ms).sort((a, b) => a - b);
  const stats = {
    concurrency: args.concurrency,
    mode: args.mode,
    n_queries: queries.length,
    n_ok: ok.length,
    n_error: errored,
    makespan_ms: result.makespan_ms,
    sum_latency_ms: ok.reduce((s, q) => s + q.latency_ms, 0),
    p50_latency_ms: percentile(latencies, 50),
    p95_latency_ms: percentile(latencies, 95),
    max_latency_ms: percentile(latencies, 100),
    total_violations: ok.reduce((s, q) => s + Math.max(q.violations, 0), 0),
  };

  // 7. Persist.
  const csvPath = path.join(args.outDir, 'per_query.csv');
  fs.writeFileSync(
    csvPath,
    'dc_num,start_us,end_us,latency_ms,violations,error\n'
    + result.per_query
        .map(q => [q.dc_num, q.start_us, q.end_us, q.latency_ms.toFixed(3), q.violations, q.error ?? '']
              .join(','))
        .join('\n')
    + '\n',
  );
  fs.writeFileSync(path.join(args.outDir, 'stats.json'), JSON.stringify(stats, null, 2));

  // 8. Sanity log.
  console.log('');
  console.log(`──────────────────────────────────────────────`);
  console.log(` Concurrency       : ${stats.concurrency}`);
  console.log(` Mode              : ${stats.mode}`);
  console.log(` Queries           : ${stats.n_queries}  (errors: ${stats.n_error})`);
  console.log(` Makespan          : ${stats.makespan_ms.toFixed(1)} ms`);
  console.log(` Sum of latencies  : ${stats.sum_latency_ms.toFixed(1)} ms`);
  console.log(` Latency p50/p95/max: ${stats.p50_latency_ms.toFixed(1)} / ${stats.p95_latency_ms.toFixed(1)} / ${stats.max_latency_ms.toFixed(1)} ms`);
  console.log(` Total violations  : ${stats.total_violations}`);
  console.log(`──────────────────────────────────────────────`);
  console.log(`Wrote: ${csvPath}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
