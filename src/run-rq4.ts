/**
 * run-rq4.ts
 *
 * RQ4 — Semantic Query Optimization via Join Elimination.
 *
 * Demonstrates and benchmarks the JoinEliminationRewriter on the tax500k
 * dataset. The experiment uses DC #10 (fname → gender), which holds with
 * zero violations, to automatically eliminate a redundant lookup join.
 *
 * Experimental setup:
 *   1. Create tax_gender(fname, gender) UNIQUE(fname) from tax500k.
 *   2. Q  = SELECT t.fname, t.salary, t.state
 *            FROM tax500k t
 *            INNER JOIN tax_gender g ON t.fname = g.fname
 *            WHERE t.salary > 50000
 *   3. Q' = JoinEliminationRewriter output (JOIN removed automatically).
 *   4. Correctness: verify COUNT(Q) == COUNT(Q').
 *   5. Timing: k independent trials for each query (with optional warmup).
 *   6. Output: JSON + Markdown summary to --out directory.
 *
 * Usage:
 *   npx ts-node src/run-rq4.ts \
 *     --table     tax500k       \
 *     --k         5             \
 *     [--warmup]                \
 *     [--skip-setup]            \
 *     --out       /path/to/out  \
 *     [--host localhost] [--port 5432] [--db dctest] [--user postgres] [--pass ""]
 */

import * as fs from "fs";
import * as path from "path";
import { Pool } from "pg";
import { DCParser } from "./parser";
import { JoinEliminationRewriter } from "./je";
import { DBConfig } from "./types";

// ─── DC that encodes FD fname → gender on tax500k ────────────────────────────

const DC_STRING =
  "¬(t0.tax500k.fname == t1.tax500k.fname ^ t0.tax500k.gender <> t1.tax500k.gender)";

const Q_WITH_JOIN = `\
SELECT t.fname, t.salary, t.state \
FROM tax500k t \
INNER JOIN tax_gender g ON t.fname = g.fname \
WHERE t.salary > 50000`;

// ─── Argument parsing ────────────────────────────────────────────────────────

interface Args {
  table: string;
  k: number;
  warmup: boolean;
  skipSetup: boolean;
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
    outDir: "results-rq4",
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
      case "--table":      args.table = argv[++i]; break;
      case "--k":          args.k = parseInt(argv[++i], 10); break;
      case "--warmup":     args.warmup = true; break;
      case "--skip-setup": args.skipSetup = true; break;
      case "--out":        args.outDir = argv[++i]; break;
      case "--host":       args.dbConfig.host = argv[++i]; break;
      case "--port":       args.dbConfig.port = parseInt(argv[++i], 10); break;
      case "--db":         args.dbConfig.database = argv[++i]; break;
      case "--user":       args.dbConfig.user = argv[++i]; break;
      case "--pass":       args.dbConfig.password = argv[++i]; break;
    }
  }
  return args;
}

// ─── Timing helpers ──────────────────────────────────────────────────────────

async function timeSingle(pool: Pool, sql: string): Promise<number> {
  const wrapped = `SELECT COUNT(*) FROM (${sql}) _timing_wrapper`;
  const t0 = Date.now();
  await pool.query(wrapped);
  return Date.now() - t0;
}

async function runKTrials(
  pool: Pool,
  sql: string,
  k: number,
  warmup: boolean
): Promise<number[]> {
  if (warmup) await timeSingle(pool, sql);
  const times: number[] = [];
  for (let i = 0; i < k; i++) {
    times.push(await timeSingle(pool, sql));
    process.stdout.write(".");
  }
  process.stdout.write("\n");
  return times;
}

function computeStats(times: number[]) {
  const mean = times.reduce((a, b) => a + b, 0) / times.length;
  const variance =
    times.length > 1
      ? times.reduce((s, x) => s + (x - mean) ** 2, 0) / (times.length - 1)
      : 0;
  const std = Math.sqrt(variance);
  return { mean, std, cv: mean > 0 ? std / mean : 0 };
}

// ─── Database setup ──────────────────────────────────────────────────────────

async function setupLookupTable(pool: Pool, baseTable: string): Promise<void> {
  console.log(`Setting up lookup table tax_gender from ${baseTable}...`);
  await pool.query("DROP TABLE IF EXISTS tax_gender");
  await pool.query(`
    CREATE TABLE tax_gender AS
    SELECT DISTINCT fname, gender FROM "${baseTable}"
  `);
  await pool.query(`
    ALTER TABLE tax_gender
    ADD CONSTRAINT pk_tax_gender PRIMARY KEY (fname)
  `);
  const res = await pool.query("SELECT COUNT(*) AS n FROM tax_gender");
  console.log(`  tax_gender created: ${res.rows[0].n} distinct fname values`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  const pool = new Pool({
    host: args.dbConfig.host,
    port: args.dbConfig.port,
    database: args.dbConfig.database,
    user: args.dbConfig.user,
    password: args.dbConfig.password,
    max: 1,
  });

  try {
    // 1. Optionally create the lookup table
    if (!args.skipSetup) {
      await setupLookupTable(pool, args.table);
    } else {
      console.log("Skipping setup (--skip-setup).");
    }

    // 2. Run the join elimination rewriter
    console.log("\nRunning JoinEliminationRewriter...");
    const dcParser = new DCParser();
    const rewriter = new JoinEliminationRewriter(dcParser, pool);
    const jeResult = await rewriter.rewrite(Q_WITH_JOIN, [DC_STRING]);

    if (!jeResult.applicable) {
      throw new Error(
        "JoinEliminationRewriter did not find the JOIN eligible for elimination. " +
        "Check that tax_gender has a UNIQUE constraint on fname."
      );
    }

    const Q_OPTIMIZED = jeResult.optimizedSQL;
    console.log(`  Eliminated: ${jeResult.eliminated.length} JOIN(s)`);
    console.log(`  Q  = ${Q_WITH_JOIN}`);
    console.log(`  Q' = ${Q_OPTIMIZED}`);

    // 3. Correctness check: both queries must return the same row count
    console.log("\nCorrectness check...");
    const [countQ, countQp] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS n FROM (${Q_WITH_JOIN}) _c`),
      pool.query(`SELECT COUNT(*) AS n FROM (${Q_OPTIMIZED}) _c`),
    ]);
    const nQ = parseInt(countQ.rows[0].n, 10);
    const nQp = parseInt(countQp.rows[0].n, 10);
    const rowsMatch = nQ === nQp;
    console.log(`  Q  row count: ${nQ}`);
    console.log(`  Q' row count: ${nQp}`);
    console.log(`  Match: ${rowsMatch ? "✓ YES" : "✗ NO — CORRECTNESS FAILURE"}`);
    if (!rowsMatch) {
      throw new Error(`Correctness failure: Q returned ${nQ} rows, Q' returned ${nQp}.`);
    }

    // 4. Timing — Q
    const rowCount = await pool.query(`SELECT COUNT(*) AS n FROM "${args.table}"`);
    console.log(`\nTiming Q (k=${args.k}${args.warmup ? ", 1 warmup" : ""})...`);
    const timesQ = await runKTrials(pool, Q_WITH_JOIN, args.k, args.warmup);

    // 5. Timing — Q'
    console.log(`Timing Q' (k=${args.k}${args.warmup ? ", 1 warmup" : ""})...`);
    const timesQp = await runKTrials(pool, Q_OPTIMIZED, args.k, args.warmup);

    // 6. Compute statistics
    const statsQ = computeStats(timesQ);
    const statsQp = computeStats(timesQp);
    const speedup = statsQ.mean / statsQp.mean;

    console.log(`\nResults:`);
    console.log(`  Q  mean=${statsQ.mean.toFixed(1)} ms  std=${statsQ.std.toFixed(1)} ms  cv=${(statsQ.cv * 100).toFixed(1)}%`);
    console.log(`  Q' mean=${statsQp.mean.toFixed(1)} ms  std=${statsQp.std.toFixed(1)} ms  cv=${(statsQp.cv * 100).toFixed(1)}%`);
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);

    // 7. Write output
    fs.mkdirSync(args.outDir, { recursive: true });

    const output: RQ4Output = {
      metadata: {
        table: args.table,
        rowCount: parseInt(rowCount.rows[0].n, 10),
        dc: DC_STRING,
        fd: "fname → gender",
        queryQ: Q_WITH_JOIN,
        queryQPrime: Q_OPTIMIZED,
        k: args.k,
        warmup: args.warmup,
        timestamp: new Date().toISOString(),
        host: args.dbConfig.host,
        database: args.dbConfig.database,
      },
      correctness: {
        rowCountQ: nQ,
        rowCountQPrime: nQp,
        match: rowsMatch,
      },
      timingQ_ms: timesQ,
      timingQPrime_ms: timesQp,
      summary: {
        meanQ_ms: Math.round(statsQ.mean * 10) / 10,
        stdQ_ms: Math.round(statsQ.std * 10) / 10,
        cvQ: Math.round(statsQ.cv * 1000) / 10,
        meanQPrime_ms: Math.round(statsQp.mean * 10) / 10,
        stdQPrime_ms: Math.round(statsQp.std * 10) / 10,
        cvQPrime: Math.round(statsQp.cv * 1000) / 10,
        speedup: Math.round(speedup * 100) / 100,
      },
    };

    const jsonPath = path.join(args.outDir, "rq4_results.json");
    fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));
    console.log(`\nJSON written to ${jsonPath}`);

    const md = buildMarkdown(output);
    const mdPath = path.join(args.outDir, "rq4_summary.md");
    fs.writeFileSync(mdPath, md);
    console.log(`Markdown written to ${mdPath}`);

  } finally {
    await pool.end();
  }
}

interface RQ4Output {
  metadata: {
    table: string; rowCount: number; dc: string; fd: string;
    queryQ: string; queryQPrime: string; k: number; warmup: boolean;
    timestamp: string; host: string; database: string;
  };
  correctness: { rowCountQ: number; rowCountQPrime: number; match: boolean };
  timingQ_ms: number[];
  timingQPrime_ms: number[];
  summary: {
    meanQ_ms: number; stdQ_ms: number; cvQ: number;
    meanQPrime_ms: number; stdQPrime_ms: number; cvQPrime: number;
    speedup: number;
  };
}

function buildMarkdown(o: RQ4Output): string {
  const s = o.summary;
  return `# RQ4 — Join Elimination Results

**Dataset:** \`${o.metadata.table}\` (${o.metadata.rowCount.toLocaleString()} rows)
**DC:** \`${o.metadata.dc}\`
**FD:** ${o.metadata.fd}
**k:** ${o.metadata.k} trials${o.metadata.warmup ? " (1 warmup discarded)" : ""}
**Timestamp:** ${o.metadata.timestamp}
**Host:** ${o.metadata.host}

## Queries

**Q (with JOIN):**
\`\`\`sql
${o.metadata.queryQ}
\`\`\`

**Q' (after JE):**
\`\`\`sql
${o.metadata.queryQPrime}
\`\`\`

## Correctness

| Q rows | Q' rows | Match |
|--------|---------|-------|
| ${o.correctness.rowCountQ.toLocaleString()} | ${o.correctness.rowCountQPrime.toLocaleString()} | ${o.correctness.match ? "✓" : "✗"} |

## Timing

| Query | Mean (ms) | Std (ms) | CV (%) | Raw trials (ms) |
|-------|-----------|----------|--------|-----------------|
| Q     | ${s.meanQ_ms} | ${s.stdQ_ms} | ${s.cvQ} | ${o.timingQ_ms.join(", ")} |
| Q'    | ${s.meanQPrime_ms} | ${s.stdQPrime_ms} | ${s.cvQPrime} | ${o.timingQPrime_ms.join(", ")} |

**Speedup Q → Q': ${s.speedup}×**
`;
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
