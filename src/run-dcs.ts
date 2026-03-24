/**
 * run-dcs.ts
 *
 * CLI entrypoint: loads a CSV dataset into PostgreSQL, then runs a set of
 * Denial Constraints (from a file or command-line arguments) and prints
 * the violations found.
 *
 * Usage:
 *   npx ts-node src/run-dcs.ts \
 *     --csv   path/to/dataset.csv \
 *     --table my_table \
 *     --dcs   path/to/soundDCs.txt \
 *     [--host localhost] [--port 5432] [--db dctest] [--user postgres] [--pass ""]
 *
 * Environment variables (override CLI):
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD
 *
 * Example (quick smoke test — no CSV loading):
 *   npx ts-node src/run-dcs.ts \
 *     --dc "¬(t0.orders.ProductID==t1.orders.ProductID^t0.orders.UnitPrice<>t1.orders.UnitPrice)" \
 *     --table orders
 */

import * as path from "path";
import { Client } from "pg";
import { loadCSV } from "./loader";
import { DCRunner } from "./runner";
import { DBConfig } from "./types";

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface Args {
  csv?: string;
  table?: string;
  dcsFile?: string;
  dcsList: string[];
  limit?: number;
  dbConfig: DBConfig;
  verbose: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = {
    dcsList: [],
    verbose: false,
    dbConfig: {
      host: process.env.PGHOST ?? "localhost",
      port: parseInt(process.env.PGPORT ?? "5432", 10),
      database: process.env.PGDATABASE ?? "dctest",
      user: process.env.PGUSER ?? "postgres",
      password: process.env.PGPASSWORD ?? "",
    },
  };

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];

    switch (flag) {
      case "--csv":    args.csv = path.resolve(next); i++; break;
      case "--table":  args.table = next; i++; break;
      case "--dcs":    args.dcsFile = path.resolve(next); i++; break;
      case "--dc":     args.dcsList.push(next); i++; break;
      case "--limit":  args.limit = parseInt(next, 10); i++; break;
      case "--host":   args.dbConfig.host = next; i++; break;
      case "--port":   args.dbConfig.port = parseInt(next, 10); i++; break;
      case "--db":     args.dbConfig.database = next; i++; break;
      case "--user":   args.dbConfig.user = next; i++; break;
      case "--pass":   args.dbConfig.password = next; i++; break;
      case "--verbose":
      case "-v":       args.verbose = true; break;
    }
  }

  return args;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function printSeparator() {
  console.log("─".repeat(72));
}

function printResult(
  idx: number,
  dcString: string,
  sql: string,
  violationCount: number,
  violations: Record<string, unknown>[],
  error?: string,
  verbose = false
) {
  printSeparator();
  console.log(`DC #${idx + 1}: ${dcString}`);

  if (error) {
    console.error(`  ❌ ERROR: ${error}`);
    if (sql) {
      console.log("  Generated SQL:");
      sql.split("\n").forEach((l) => console.log("  " + l));
    }
    return;
  }

  if (violationCount === 0) {
    console.log("  ✅ No violations found.");
  } else {
    console.log(`  ⚠️  ${violationCount} violation(s) found.`);
    if (verbose && violations.length > 0) {
      console.log("\n  First violations:");
      const preview = violations.slice(0, 5);
      preview.forEach((row, i) => {
        console.log(`  [${i + 1}]`, JSON.stringify(row));
      });
      if (violations.length > 5) {
        console.log(`  ... and ${violations.length - 5} more`);
      }
    }
  }

  if (verbose) {
    console.log("\n  Generated SQL:");
    sql.split("\n").forEach((l) => console.log("  " + l));
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  console.log("═".repeat(72));
  console.log(" Denial Constraints → SQL Runner");
  console.log("═".repeat(72));
  console.log(`Database: ${args.dbConfig.user}@${args.dbConfig.host}:${args.dbConfig.port}/${args.dbConfig.database}`);

  // ── Step 1: optionally load CSV ───────────────────────────────────────────
  if (args.csv) {
    if (!args.table) {
      console.error("Error: --table is required when --csv is provided.");
      process.exit(1);
    }

    console.log(`\nLoading CSV: ${args.csv} → table "${args.table}"`);
    const client = new Client(args.dbConfig);
    await client.connect();
    try {
      await loadCSV(client, args.csv, args.table, {
        dropIfExists: true,
        limit: args.limit,
      });
    } finally {
      await client.end();
    }
  }

  // ── Step 2: build list of DCs to run ─────────────────────────────────────
  let dcStrings: string[] = [...args.dcsList];

  if (args.dcsFile) {
    const fs = await import("fs");
    const content = fs.readFileSync(args.dcsFile, "utf-8");
    const fileDCs = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
    dcStrings = dcStrings.concat(fileDCs);
    console.log(`\nLoaded ${fileDCs.length} DCs from ${args.dcsFile}`);
  }

  if (dcStrings.length === 0) {
    console.error(
      "\nError: no DCs to run. Provide --dc \"<dc>\" or --dcs <file>."
    );
    process.exit(1);
  }

  // ── Step 3: run DCs ───────────────────────────────────────────────────────
  console.log(`\nRunning ${dcStrings.length} DC(s)...\n`);
  const runner = new DCRunner(args.dbConfig);
  const results = await runner.runAll(dcStrings);

  // ── Step 4: print results ─────────────────────────────────────────────────
  let totalViolations = 0;
  let errors = 0;

  results.forEach((r, i) => {
    printResult(
      i,
      r.dcString,
      r.sql,
      r.violationCount,
      r.violations,
      r.error,
      args.verbose
    );
    totalViolations += r.violationCount;
    if (r.error) errors++;
  });

  printSeparator();
  console.log(
    `\nSummary: ${results.length} DCs checked, ${totalViolations} total violation(s), ${errors} error(s).`
  );
  console.log("═".repeat(72));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
