import { DenialConstraint } from "../types";

/**
 * A functional dependency extracted from a FD-shaped denial constraint.
 *
 * Grounding: Chu et al. 2013 (chu2013discovering) establish that FDs are
 * special cases of DCs; specifically, ¬(t.X == t'.X ∧ t.Y != t'.Y) encodes
 * the FD X → Y.
 */
export interface FunctionalDependency {
  /** Left-hand side of the FD (one or more determinant columns). */
  determinant: string[];
  /** Right-hand side of the FD (the single dependent column). */
  dependent: string;
  /** Relation on which the FD holds. */
  tableName: string;
  /** The source DC that encodes this FD. */
  sourceDC: DenialConstraint;
}

/**
 * A redundant JOIN identified by the JE algorithm.
 *
 * Grounding: Pena et al. 2018 (pena2018fdsel) — join elimination conditions.
 */
export interface JEOpportunity {
  /** Table alias of the joined table to be eliminated. */
  joinAlias: string;
  /** Actual table name of the joined table. */
  joinTable: string;
  /** Column(s) used as the join key on the joined-table side. */
  joinKeyCols: string[];
  /** The FD that justifies this elimination. */
  fd: FunctionalDependency;
}

/** Result returned by the Join Elimination rewriter. */
export interface JEResult {
  originalSQL: string;
  optimizedSQL: string;
  /** All JOINs that were eliminated. Empty if no JE was applicable. */
  eliminated: JEOpportunity[];
  /** True iff at least one JOIN was eliminated. */
  applicable: boolean;
}

/** Options controlling JE rewriter behaviour. */
export interface JEOptions {
  /**
   * Skip the runtime database check that verifies the join key is unique
   * in the joined table. Set to true for unit testing or when the caller
   * can guarantee uniqueness externally.
   *
   * Default: false (key check is performed when a Pool is provided).
   */
  skipKeyCheck?: boolean;
}
