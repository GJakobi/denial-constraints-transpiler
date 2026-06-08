/**
 * Utilities for traversing and inspecting node-sql-parser ASTs.
 *
 * node-sql-parser (PostgreSQL dialect) represents column names as nested
 * objects: column_ref.column = { expr: { type: "default", value: "col" } }
 * except for the star wildcard where column_ref.column = "*" (bare string).
 */

/** Extract a plain string from a node-sql-parser column field. */
export function colName(col: unknown): string {
  if (typeof col === "string") return col; // handles "*"
  if (col && typeof col === "object") {
    const c = col as Record<string, unknown>;
    if (c["expr"] && typeof c["expr"] === "object") {
      const expr = c["expr"] as Record<string, unknown>;
      if (typeof expr["value"] === "string") return expr["value"];
    }
  }
  return String(col);
}

/** Extract a plain string from a node-sql-parser table field (may be string or {value}). */
export function tblName(tbl: unknown): string | null {
  if (tbl === null || tbl === undefined) return null;
  if (typeof tbl === "string") return tbl;
  if (typeof tbl === "object") {
    const t = tbl as Record<string, unknown>;
    if (typeof t["value"] === "string") return t["value"];
  }
  return null;
}

/**
 * Recursively collect all column names referenced with a given table alias
 * in any part of an AST node.
 *
 * Only qualified references (those carrying the explicit table alias) are
 * collected. Unqualified references (table === null) are conservatively
 * ignored — the caller must not eliminate a join when unqualified columns
 * from the joined table might be present.
 *
 * @param node  Any AST node (or sub-node) from node-sql-parser.
 * @param alias The table alias whose column references we are collecting.
 * @returns     Set of column name strings referenced via that alias.
 */
export function collectColumnRefs(node: unknown, alias: string): Set<string> {
  const refs = new Set<string>();
  walk(node, alias, refs);
  return refs;
}

function walk(node: unknown, alias: string, refs: Set<string>): void {
  if (node === null || node === undefined) return;
  if (typeof node !== "object") return;

  if (Array.isArray(node)) {
    node.forEach((item) => walk(item, alias, refs));
    return;
  }

  const n = node as Record<string, unknown>;

  if (n["type"] === "column_ref") {
    const t = tblName(n["table"]);
    if (t === alias) {
      refs.add(colName(n["column"]));
    }
    return; // column_ref has no further children worth walking
  }

  // Recurse into all object/array valued properties
  for (const val of Object.values(n)) {
    if (val !== null && typeof val === "object") {
      walk(val, alias, refs);
    }
  }
}

/**
 * Returns true if the SELECT list contains a bare star (*) or a qualified
 * star (t.*), meaning JE cannot be safely applied (removing a join could
 * drop columns from the result set).
 */
export function hasSelectStar(ast: Record<string, unknown>): boolean {
  const columns = ast["columns"];
  if (columns === "*") return true; // rare: SELECT * bare string
  if (!Array.isArray(columns)) return false;

  for (const item of columns) {
    if (!item || typeof item !== "object") continue;
    const col = item as Record<string, unknown>;
    const expr = col["expr"] as Record<string, unknown> | undefined;
    if (!expr) continue;
    if (expr["type"] === "column_ref") {
      const c = colName(expr["column"]);
      if (c === "*") return true;
    }
  }
  return false;
}

export interface JoinKeyInfo {
  /** Alias of the base (non-joined) table side. */
  baseAlias: string;
  /** Column name(s) on the base table side of the join condition. */
  baseCols: string[];
  /** Alias of the joined table side. */
  joinAlias: string;
  /** Column name(s) on the joined table side of the join condition. */
  joinCols: string[];
}

/**
 * Extract join key information from a JOIN node's ON or USING clause.
 *
 * Handles:
 *   - ON t.col = g.col         (binary equality)
 *   - ON t.c1 = g.c1 AND t.c2 = g.c2  (composite key via AND chain)
 *   - USING (col)              (same column name on both sides)
 *
 * @param join      The JOIN entry from ast.from[].
 * @param joinAlias The resolved alias of the joined table.
 * @returns         Key info, or null if the join condition cannot be parsed.
 */
export function extractJoinKey(
  join: Record<string, unknown>,
  joinAlias: string
): JoinKeyInfo | null {
  // --- USING clause ---
  if (Array.isArray(join["using"])) {
    const using = join["using"] as Array<Record<string, unknown>>;
    if (using.length === 0) return null;
    const cols = using.map((u) =>
      typeof u["value"] === "string" ? u["value"] : colName(u)
    );
    // USING means the same column name appears on both sides;
    // we don't know the base alias here, so we use a placeholder
    return { baseAlias: "__any__", baseCols: cols, joinAlias, joinCols: cols };
  }

  // --- ON clause ---
  const on = join["on"] as Record<string, unknown> | undefined;
  if (!on) return null;

  return extractEqualities(on, joinAlias);
}

/**
 * Recursively extract equality conditions from an ON expression.
 * Handles a single `a.col = b.col` or an AND chain of such conditions.
 */
function extractEqualities(
  expr: Record<string, unknown>,
  joinAlias: string
): JoinKeyInfo | null {
  if (expr["type"] === "binary_expr") {
    const op = expr["operator"] as string;

    // AND chain: recurse into both branches and merge
    if (op === "AND") {
      const left = extractEqualities(
        expr["left"] as Record<string, unknown>,
        joinAlias
      );
      const right = extractEqualities(
        expr["right"] as Record<string, unknown>,
        joinAlias
      );
      if (!left || !right) return null;
      // Both branches must agree on which side is the join alias
      if (left.joinAlias !== right.joinAlias) return null;
      return {
        baseAlias: left.baseAlias,
        baseCols: [...left.baseCols, ...right.baseCols],
        joinAlias: left.joinAlias,
        joinCols: [...left.joinCols, ...right.joinCols],
      };
    }

    // Simple equality: a.col = b.col
    if (op === "=") {
      const l = expr["left"] as Record<string, unknown>;
      const r = expr["right"] as Record<string, unknown>;
      if (l["type"] !== "column_ref" || r["type"] !== "column_ref") return null;

      const lTable = tblName(l["table"]);
      const rTable = tblName(r["table"]);
      const lCol = colName(l["column"]);
      const rCol = colName(r["column"]);

      if (lTable === null || rTable === null) return null;

      // Determine which side is the joined table
      if (rTable === joinAlias) {
        return {
          baseAlias: lTable,
          baseCols: [lCol],
          joinAlias: rTable,
          joinCols: [rCol],
        };
      } else if (lTable === joinAlias) {
        return {
          baseAlias: rTable,
          baseCols: [rCol],
          joinAlias: lTable,
          joinCols: [lCol],
        };
      }
    }
  }
  return null;
}
