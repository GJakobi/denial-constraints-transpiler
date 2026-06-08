/**
 * run-rq4.ts
 *
 * RQ4 — Semantic Query Optimization via Join Elimination.
 *
 * Benchmarks the JoinEliminationRewriter on tax500k using DC #8 (zip → state).
 * Runs three structurally different queries to show the rewriter is generic:
 *
 *   Q1 — Simple SELECT with a WHERE filter
 *   Q2 — GROUP BY aggregate with HAVING
 *   Q3 — Multi-column SELECT with a more selective filter
 *
 * Each query is automatically rewritten (Q → Q') by the JoinEliminationRewriter
 * and then timed over k independent trials (with optional warm-up).
 *
 * Timing uses a COUNT(*) subquery wrapper so wall-clock measures pure
 * query execution, not result-set transfer time.
 *
 * Usage:
 *   npx ts-node src/run-rq4.ts \
 *     [--table     tax500k]          \
 *     [--csv       /path/to.csv]     reload table from CSV first  \
 *     [--k         5]                \
 *     [--warmup]                     discard 1 run per query     \
 *     [--skip-setup]                 skip creating tax_zip table  \
 *     [--no-parallel]                SET max_parallel_workers_per_gather=0  \
 *     [--out       experiments/results-rq4]  \
 *     [--host localhost] [--port 5432] [--db dctest] [--user postgres] [--pass ""]
 */

import * as fs from "fs";
import * as path from "path";
import { Client, Pool } from "pg";
import { loadCSV } from "./loader";
import { DCParser } from "./parser";
import { JoinEliminationRewriter } from "./je";
import { DBConfig } from "./types";

// ─── DC #8: zip → state ───────────────────────────────────────────────────────

const DC_STRING =
  "¬(t0.tax500k.zip == t1.tax500k.zip ^ t0.tax500k.state <> t1.tax500k.state)";

// ─── Benchmark queries (all use INNER JOIN tax_zip z ON t.zip = z.zip) ───────

interface BenchmarkQuery {
  name: string;
  description: string;
  sql: string;
}

const QUERIES: BenchmarkQuery[] = [
  {
    name: "Q1",
    description: "Simple SELECT with salary filter",
    sql:
      "SELECT t.fname, t.salary, t.state " +
      "FROM tax500k t " +
      "INNER JOIN tax_zip z ON t.zip = z.zip " +
      "WHERE t.salary > 50000",
  },
  {
    name: "Q2",
    description: "GROUP BY aggregate: taxpayers and avg salary per state",
    sql:
      "SELECT t.state, COUNT(*) AS taxpayers, AVG(t.salary) AS avg_salary " +
      "FROM tax500k t " +
      "INNER JOIN tax_zip z ON t.zip = z.zip " +
      "GROUP BY t.state " +
      "HAVING COUNT(*) > 1000 " +
      "ORDER BY t.state",
  },
  {
    name: "Q3",
    description: "Multi-column SELECT: high earners with married status",
    sql:
      "SELECT t.fname, t.lname, t.salary, t.areacode, t.state " +
      "FROM tax500k t " +
      "INNER JOIN tax_zip z ON t.zip = z.zip " +
      "WHERE t.salary > 100000",
  },
];

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface Args {
  table: string;
  csvPath?: string;
  k: number;
  warmup: boolean;
  skipSetup: boolean;
  noParallel: boolean;
  outDir: string;
  dbConfig: DBConfig;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    table: "tax500k",
    k: 5,
    warmup: false,
    skipSetup: false,
    noParallel: false,
    outDir: "experiments/results-rq4",
    dbConfig: {
      host: process.env.PGHOST ?? "localhost",
      port: parseInt(process.env.PGPORT ?? "5432", 10),
      database: process.env.PGDATABASE ?? "dctest",
      user: process.env.PGUSER ?? "postgres",
      password: process.env.PGPASSWORD ?? "",
    },
  };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--table":       args.table = argv[++i]; break;
      case "--csv":         args.csvPath = argv[++i]; break;
      case "--k":           args.k = parseInt(argv[++i], 10); break;
      case "--warmup":      args.warmup = true; break;
      case "--skip-setup":  args.skipSetup = true; break;
      case "--no-parallel": args.noParallel = true; break;
      case "--out":         args.outDir = argv[++i]; break;
      case "--host":        args.dbConfig.host = argv[++i]; break;
      case "--port":        args.dbConfig.port = parseInt(argv[++i], 10); break;
      case "--db":          args.dbConfig.database = argv[++i]; break;
      case "--user":        args.dbConfig.user = argv[++i]; break;
      case "--pass":        args.dbConfig.password = argv[++i]; break;
    }
  }
  return args;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function computeStats(times: number[]) {
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance =
    times.length > 1
      ? times.reduce((s, x) => s + (x - mean) ** 2, 0) / (times.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  return { mean, std, cv: mean > 0 ? std / mean : 0 };
}

function round1(x: number) { return Math.round(x * 10) / 10; }
function round2(x: number) { return Math.round(x * 100) / 100; }

// ─── Timing (dedicated client so SET persists across calls) ──────────────────

async function timeSingle(client: Client, sql: string): Promise<number> {
  const wrapped = `SELECT COUNT(*) FROM (${sql}) _timing_wrapper`;
  const t0 = Date.now();
  await client.query(wrapped);
  return Date.now() - t0;
}

async function runKTrials(
  client: Client,
  sql: string,
  k: number,
  warmup: boolean,
  label: string
): Promise<number[]> {
  if (warmup) {
    process.stdout.write(`  ${label} warmup...`);
    await timeSingle(client, sql);
    process.stdout.write(" done\n");
  }
  process.stdout.write(`  ${label} timing: `);
  const times: number[] = [];
  for (let i = 0; i < k; i++) {
    times.push(await timeSingle(client, sql));
    process.stdout.write(".");
  }
  const stats = computeStats(times);
  process.stdout.write(` ${stats.mean.toFixed(1)} ms ± ${stats.std.toFixed(1)}\n`);
  return times;
}

// ─── Database setup ───────────────────────────────────────────────────────────

async function setupLookupTable(pool: Pool, baseTable: string): Promise<void> {
  console.log(`Setting up tax_zip from ${baseTable}...`);
  await pool.query("DROP TABLE IF EXISTS tax_zip");
  await pool.query(`CREATE TABLE tax_zip AS SELECT DISTINCT zip, state FROM "${baseTable}"`);
  await pool.query(`ALTER TABLE tax_zip ADD CONSTRAINT pk_tax_zip PRIMARY KEY (zip)`);
  const res = await pool.query("SELECT COUNT(*) AS n FROM tax_zip");
  console.log(`  tax_zip ready: ${res.rows[0].n} distinct zip values`);
}

// ─── Per-query benchmark ──────────────────────────────────────────────────────

interface QueryResult {
  name: string;
  description: string;
  queryQ: string;
  queryQPrime: string;
  correctness: { rowCountQ: number; rowCountQPrime: number; match: boolean };
  timingQ_ms: number[];
  timingQPrime_ms: number[];
  summary: {
    meanQ_ms: number; stdQ_ms: number; cvQ: number;
    meanQPrime_ms: number; stdQPrime_ms: number; cvQPrime: number;
    speedup: number;
  };
}

async function benchmarkQuery(
  bq: BenchmarkQuery,
  rewriter: JoinEliminationRewriter,
  pool: Pool,
  client: Client,
  k: number,
  warmup: boolean
): Promise<QueryResult> {
  console.log(`\n── ${bq.name}: ${bq.description}`);

  const jeResult = await rewriter.rewrite(bq.sql, [DC_STRING]);
  if (!jeResult.applicable) {
    throw new Error(`${bq.name}: JE not applicable — check DC/table setup.`);
  }
  const Q_PRIME = jeResult.optimizedSQL;
  console.log(`  Q  = ${bq.sql}`);
  console.log(`  Q' = ${Q_PRIME}`);

  // Correctness
  const [rQ, rQp] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS n FROM (${bq.sql}) _c`),
    pool.query(`SELECT COUNT(*) AS n FROM (${Q_PRIME}) _c`),
  ]);
  const nQ = parseInt(rQ.rows[0].n, 10);
  const nQp = parseInt(rQp.rows[0].n, 10);
  const match = nQ === nQp;
  console.log(`  Correctness: Q=${nQ.toLocaleString()} Q'=${nQp.toLocaleString()} ${match ? "✓" : "✗ FAIL"}`);
  if (!match) throw new Error(`${bq.name}: correctness failure`);

  // Timing
  const timesQ  = await runKTrials(client, bq.sql, k, warmup, "Q ");
  const timesQp = await runKTrials(client, Q_PRIME, k, warmup, "Q'");
  const sQ  = computeStats(timesQ);
  const sQp = computeStats(timesQp);
  const speedup = sQ.mean / sQp.mean;
  console.log(`  Speedup: ${speedup.toFixed(2)}×`);

  return {
    name: bq.name,
    description: bq.description,
    queryQ: bq.sql,
    queryQPrime: Q_PRIME,
    correctness: { rowCountQ: nQ, rowCountQPrime: nQp, match },
    timingQ_ms: timesQ,
    timingQPrime_ms: timesQp,
    summary: {
      meanQ_ms: round1(sQ.mean), stdQ_ms: round1(sQ.std), cvQ: round1(sQ.cv * 100),
      meanQPrime_ms: round1(sQp.mean), stdQPrime_ms: round1(sQp.std), cvQPrime: round1(sQp.cv * 100),
      speedup: round2(speedup),
    },
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const pool = new Pool({
    host: args.dbConfig.host, port: args.dbConfig.port,
    database: args.dbConfig.database, user: args.dbConfig.user,
    password: args.dbConfig.password, max: 2,
  });

  // Dedicated client for timing (session SET sticks for the connection lifetime)
  const client = new Client({
    host: args.dbConfig.host, port: args.dbConfig.port,
    database: args.dbConfig.database, user: args.dbConfig.user,
    password: args.dbConfig.password,
  });
  await client.connect();

  try {
    // Optional CSV reload (uses dedicated client — loadCSV takes a Client, not Pool)
    if (args.csvPath) {
      console.log(`Loading ${args.csvPath} → table "${args.table}"...`);
      await loadCSV(client, args.csvPath, args.table, { dropIfExists: true });
    }

    // Parallelism setting
    const parallelSetting = args.noParallel ? 0 : null;
    if (args.noParallel) {
      await client.query("SET max_parallel_workers_per_gather = 0");
      console.log("Parallel workers disabled for timing (--no-parallel).");
    } else {
      const r = await client.query("SHOW max_parallel_workers_per_gather");
      console.log(`Parallel workers per gather: ${r.rows[0].max_parallel_workers_per_gather}`);
    }

    // Lookup table
    if (!args.skipSetup) {
      await setupLookupTable(pool, args.table);
    }

    const rowCountRes = await pool.query(`SELECT COUNT(*) AS n FROM "${args.table}"`);
    const rowCount = parseInt(rowCountRes.rows[0].n, 10);
    console.log(`Table "${args.table}": ${rowCount.toLocaleString()} rows`);

    // Run all benchmark queries
    const dcParser = new DCParser();
    const rewriter = new JoinEliminationRewriter(dcParser, pool);
    const results: QueryResult[] = [];
    for (const bq of QUERIES) {
      results.push(await benchmarkQuery(bq, rewriter, pool, client, args.k, args.warmup));
    }

    // Output
    fs.mkdirSync(args.outDir, { recursive: true });

    const output: RQ4FullOutput = {
      metadata: {
        table: args.table,
        rowCount,
        dc: DC_STRING,
        fd: "zip → state",
        k: args.k,
        warmup: args.warmup,
        noParallel: args.noParallel,
        parallelSetting,
        timestamp: new Date().toISOString(),
        host: args.dbConfig.host,
        database: args.dbConfig.database,
      },
      queries: results,
    };

    const jsonPath = path.join(args.outDir, "rq4_results.json");
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    console.log(`\nJSON → ${jsonPath}`);

    const mdPath = path.join(args.outDir, "rq4_summary.md");
    fs.writeFileSync(mdPath, buildMarkdown(output));
    console.log(`MD   → ${mdPath}`);

  } finally {
    await client.end();
    await pool.end();
  }
}

// ─── Markdown output ──────────────────────────────────────────────────────────

interface RQ4FullOutput {
  metadata: {
    table: string; rowCount: number; dc: string; fd: string;
    k: number; warmup: boolean; noParallel: boolean;
    parallelSetting: number | null;
    timestamp: string; host: string; database: string;
  };
  queries: QueryResult[];
}

function buildMarkdown(o: RQ4FullOutput): string {
  const m = o.metadata;
  const parallelNote = m.noParallel
    ? "parallel workers disabled (`SET max_parallel_workers_per_gather = 0`)"
    : `parallel workers = ${m.parallelSetting ?? "PG default"}`;

  const qRows = o.queries.map((q) => {
    const s = q.summary;
    return `| ${q.name} | ${s.meanQ_ms} ± ${s.stdQ_ms} | ${s.meanQPrime_ms} ± ${s.stdQPrime_ms} | **${s.speedup}×** | ${s.cvQ}% / ${s.cvQPrime}% |`;
  }).join("\n");

  const qDetails = o.queries.map((q) => {
    const s = q.summary;
    return `
### ${q.name} — ${q.description}

**Q:**
\`\`\`sql
${q.queryQ}
\`\`\`
**Q' (auto-generated):**
\`\`\`sql
${q.queryQPrime}
\`\`\`
Correctness: ${q.correctness.rowCountQ.toLocaleString()} rows Q = ${q.correctness.rowCountQPrime.toLocaleString()} rows Q' ✓
Raw Q  (ms): ${q.timingQ_ms.join(", ")}
Raw Q' (ms): ${q.timingQPrime_ms.join(", ")}
`;
  }).join("\n");

  return `# RQ4 — Join Elimination Results

**Dataset:** \`${m.table}\` (${m.rowCount.toLocaleString()} rows)
**DC:** \`${m.dc}\`
**FD:** ${m.fd}
**k:** ${m.k} trials${m.warmup ? " (1 warmup discarded)" : ""}
**PG config:** ${parallelNote}
**Timestamp:** ${m.timestamp}  **Host:** ${m.host}

## Summary

| Query | Q mean ± std (ms) | Q' mean ± std (ms) | Speedup | CV Q / Q' |
|-------|-------------------|---------------------|---------|-----------|
${qRows}

## Per-query detail
${qDetails}`;
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
