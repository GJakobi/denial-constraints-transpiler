import { Parser } from "node-sql-parser";
import { Pool } from "pg";
import { DCParser } from "../parser";
import { FunctionalDependency, JEOpportunity, JEOptions, JEResult } from "./types";
import { extractFDs } from "./fd-detector";
import {
  collectColumnRefs,
  extractJoinKey,
  hasSelectStar,
  tblName,
} from "./sql-walker";

const PG_OPT = { database: "PostgresQL" } as const;

/**
 * Join Elimination rewriter.
 *
 * Given a SQL query and a set of sound denial constraints (those with zero
 * violations on the target dataset), this module:
 *   1. Extracts all FD-shaped DCs from the constraint set.
 *   2. Identifies INNER JOINs in the query that are redundant under those FDs.
 *   3. Rewrites the query by removing the redundant JOINs.
 *
 * Theoretical grounding:
 *   - Chu et al. 2013 (chu2013discovering): the connection DC → FD.
 *   - Pena et al. 2018 (pena2018fdsel): join elimination conditions under FDs.
 *
 * Scope (documented limitations):
 *   - Only INNER JOIN / JOIN; outer joins are not handled.
 *   - SELECT * and SELECT t.* are not eligible (removing a join changes schema).
 *   - Unqualified column references are treated conservatively.
 *   - Subqueries in FROM are not handled.
 */
export class JoinEliminationRewriter {
  private sqlParser = new Parser();

  /**
   * @param dcParser  DCParser instance (from Phase 1).
   * @param pool      Optional PostgreSQL pool for runtime key-uniqueness checks.
   *                  Required unless JEOptions.skipKeyCheck is true.
   */
  constructor(
    private readonly dcParser: DCParser,
    private readonly pool?: Pool
  ) {}

  /**
   * Attempt to rewrite the given SQL query by eliminating redundant JOINs.
   *
   * @param sql           A PostgreSQL SELECT statement.
   * @param soundDCStrings DC strings that hold on the target dataset (∅ violations).
   * @param options       Rewriter options.
   */
  async rewrite(
    sql: string,
    soundDCStrings: string[],
    options: JEOptions = {}
  ): Promise<JEResult> {
    // Parse DCs and extract FDs
    const dcs = soundDCStrings.map((s) => this.dcParser.parse(s));
    const fds = extractFDs(dcs);

    // Parse SQL into AST
    let ast: Record<string, unknown>;
    try {
      ast = this.sqlParser.astify(sql, PG_OPT) as unknown as Record<string, unknown>;
    } catch (e) {
      throw new Error(`SQL parse error: ${String(e)}`);
    }

    if (ast["type"] !== "select") {
      throw new Error("JE rewriter only supports SELECT statements.");
    }

    // Guard: SELECT * / SELECT t.* → refuse JE
    if (hasSelectStar(ast)) {
      return { originalSQL: sql, optimizedSQL: sql, eliminated: [], applicable: false };
    }

    const fromList = ast["from"] as Array<Record<string, unknown>>;
    if (!Array.isArray(fromList) || fromList.length < 2) {
      return { originalSQL: sql, optimizedSQL: sql, eliminated: [], applicable: false };
    }

    // Find all JOINs that are eligible for elimination
    const opportunities: JEOpportunity[] = [];
    for (const joinEntry of fromList) {
      if (!joinEntry["join"]) continue; // base table entry

      const joinType = (joinEntry["join"] as string).toUpperCase();
      if (joinType !== "INNER JOIN" && joinType !== "JOIN") continue;

      const joinTable = joinEntry["table"] as string;
      const joinAlias = (joinEntry["as"] as string | null) ?? joinTable;

      const keyInfo = extractJoinKey(joinEntry, joinAlias);
      if (!keyInfo) continue;

      // Check: no column of the joined alias (besides the join key) is used
      const usedCols = collectColumnRefs(ast, joinAlias);
      // Remove join-key columns — their presence in the ON condition is expected
      for (const k of keyInfo.joinCols) usedCols.delete(k);

      if (usedCols.size > 0) continue; // joined table has columns in use

      // Find a matching FD
      const fd = findMatchingFD(fds, keyInfo.baseCols, fromList, joinAlias);
      if (!fd) continue;

      // Runtime key-uniqueness check (skippable for unit tests)
      if (!options.skipKeyCheck) {
        if (!this.pool) {
          throw new Error(
            "A PostgreSQL Pool is required for key-uniqueness checks. " +
            "Pass skipKeyCheck: true to skip (only safe when uniqueness is guaranteed)."
          );
        }
        const isUnique = await checkKeyUnique(this.pool, joinTable, keyInfo.joinCols);
        if (!isUnique) continue;
      }

      opportunities.push({
        joinAlias,
        joinTable,
        joinKeyCols: keyInfo.joinCols,
        fd,
      });
    }

    if (opportunities.length === 0) {
      return { originalSQL: sql, optimizedSQL: sql, eliminated: [], applicable: false };
    }

    // Apply all eliminations: remove the eligible JOIN entries from ast.from
    const eliminatedAliases = new Set(opportunities.map((o) => o.joinAlias));
    const newFrom = fromList.filter(
      (entry) =>
        !entry["join"] || // keep base tables
        !eliminatedAliases.has((entry["as"] as string | null) ?? (entry["table"] as string))
    );
    const modifiedAst = { ...ast, from: newFrom };

    const optimizedSQL = this.sqlParser.sqlify(
      modifiedAst as unknown as Parameters<typeof this.sqlParser.sqlify>[0],
      PG_OPT
    );

    return {
      originalSQL: sql,
      optimizedSQL,
      eliminated: opportunities,
      applicable: true,
    };
  }
}

/**
 * Find an FD whose determinant columns match the join key AND whose table
 * matches one of the base (non-joined) tables in the FROM list.
 */
function findMatchingFD(
  fds: FunctionalDependency[],
  joinKeyCols: string[],
  fromList: Array<Record<string, unknown>>,
  joinAlias: string
): FunctionalDependency | null {
  // Collect base table names (those without a `join` property)
  const baseTables = new Set<string>();
  for (const entry of fromList) {
    if (!entry["join"]) {
      const t = tblName(entry["table"]);
      if (t) baseTables.add(t);
      // Also consider aliased base tables
      const alias = tblName(entry["as"]);
      if (alias) baseTables.add(alias);
    }
  }

  for (const fd of fds) {
    // The FD must be on one of the base tables
    if (!baseTables.has(fd.tableName)) continue;

    // The FD's determinant must match the join key columns (as a set)
    if (!setsEqual(new Set(fd.determinant), new Set(joinKeyCols))) continue;

    return fd;
  }
  return null;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Check that the given columns form a unique key in the specified table.
 *
 * Executes: SELECT COUNT(*) = COUNT(DISTINCT (col1, col2, ...)) AS is_key FROM table
 *
 * This is the runtime uniqueness check that validates the JE pre-condition:
 * every row in the base table must have at most one matching row in the
 * joined table (pena2018fdsel, join-key uniqueness condition).
 */
async function checkKeyUnique(
  pool: Pool,
  tableName: string,
  keyCols: string[]
): Promise<boolean> {
  const quoted = keyCols.map((c) => `"${c}"`).join(", ");
  const distinctExpr = keyCols.length === 1 ? quoted : `(${quoted})`;
  const query = `
    SELECT COUNT(*) = COUNT(DISTINCT ${distinctExpr}) AS is_key
    FROM "${tableName}"
  `;
  const result = await pool.query(query);
  return result.rows[0]?.is_key === true;
}
