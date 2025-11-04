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
