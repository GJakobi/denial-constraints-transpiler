/**
 * runner.ts
 *
 * Runs transpiled SQL queries for Denial Constraints against a PostgreSQL
 * database and returns the violations found.
 */

import { Client } from "pg";
import { DCParser } from "./parser";
import { DCTranspiler } from "./transpiler";
import { DBConfig, DCRunResult } from "./types";

/**
 * DCRunner — connects to PostgreSQL, transpiles DCs and executes
 * the generated violation-detection queries.
 */
export class DCRunner {
  private config: DBConfig;
  private parser: DCParser;
  private transpiler: DCTranspiler;

  constructor(config: DBConfig) {
    this.config = config;
    this.parser = new DCParser();
    this.transpiler = new DCTranspiler({
      selectAllColumns: true,
      formatOutput: true,
      includeComments: false,
    });
  }

  /**
   * Run a single DC string against the database.
   *
   * @param dcString  The denial constraint in textual form,
   *                  e.g. "¬(t0.orders.salary < t1.orders.salary ^ ...)"
   * @returns         DCRunResult with violations and SQL used.
   */
  async runDC(dcString: string): Promise<DCRunResult> {
    let sql = "";

    try {
      // ── 1. Parse + transpile ──────────────────────────────────────────────
      const dc = this.parser.parse(dcString);
      this.parser.validate(dc);
      sql = this.transpiler.transpile(dc);

      // ── 2. Execute against PostgreSQL ─────────────────────────────────────
      const client = new Client(this.config);
      await client.connect();

      let rows: Record<string, unknown>[] = [];
      try {
        const result = await client.query(sql);
        rows = result.rows;
      } finally {
        await client.end();
      }

      return {
        dcString,
        sql,
        violationCount: rows.length,
        violations: rows,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        dcString,
        sql,
        violationCount: 0,
        violations: [],
        error: message,
      };
    }
  }

  /**
   * Run multiple DCs against the database in sequence.
   *
   * @param dcStrings  Array of DC strings.
   * @returns          Array of DCRunResult, one per DC.
   */
  async runAll(dcStrings: string[]): Promise<DCRunResult[]> {
    const results: DCRunResult[] = [];

    for (const dc of dcStrings) {
      const result = await this.runDC(dc);
      results.push(result);
    }

    return results;
  }

  /**
   * Read a file that contains one DC per line (lines starting with '#'
   * or empty lines are ignored) and run all of them.
   *
   * This matches the output format from tools like FastDC / DCValidity.
   *
   * @param filePath  Absolute path to the .txt file with DCs.
   * @returns         Array of DCRunResult.
   */
  async runFromFile(filePath: string): Promise<DCRunResult[]> {
    const fs = await import("fs");
    const content = fs.readFileSync(filePath, "utf-8");

    const dcStrings = content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));

    console.log(`Running ${dcStrings.length} DCs from ${filePath}...`);
    return this.runAll(dcStrings);
  }
}
