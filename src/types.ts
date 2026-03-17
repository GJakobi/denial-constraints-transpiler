/**
 * Types for representing denial constraints and SQL components
 */

export type ComparisonOperator = "==" | "<>" | "<=" | ">=" | "<" | ">";

export interface TupleReference {
  tupleId: string; // e.g., "t0", "t1"
  tableName: string; // e.g., "employees", "WDC_planets.csv"
  columnName: string; // e.g., "Role", "Hours"
}

export interface Predicate {
  left: TupleReference;
  operator: ComparisonOperator;
  right: TupleReference;
}

export interface DenialConstraint {
  predicates: Predicate[];
}

export interface SQLQuery {
  selectColumns: string[];
  fromClause: string;
  whereConditions: string[];
}

export interface TranspilerOptions {
  selectAllColumns?: boolean;
  formatOutput?: boolean;
  includeComments?: boolean;
}

// ─── Database runner types ────────────────────────────────────────────────────

/** PostgreSQL connection configuration */
export interface DBConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

/** A single DC violation: pair of row IDs that together violate the constraint */
export interface Violation {
  dcString: string;
  sql: string;
  rows: Record<string, unknown>[];
}

/** Result of running one DC against the database */
export interface DCRunResult {
  dcString: string;
  sql: string;
  violationCount: number;
  violations: Violation["rows"];
  error?: string;
}

/** Options for loading a CSV into a table */
export interface LoadCSVOptions {
  /** Drop the table first if it already exists (default: true) */
  dropIfExists?: boolean;
  /** Row limit — load only the first N rows (default: all) */
  limit?: number;
}
