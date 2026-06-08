import { DenialConstraint } from "../types";
import { FunctionalDependency } from "./types";

/**
 * Detect whether a DC encodes a functional dependency and extract it.
 *
 * A DC is FD-shaped iff all four conditions hold:
 *   1. Every predicate uses only == or <> (no order operators <, <=, >, >=).
 *   2. Each predicate's left and right sides reference the same column name
 *      (e.g., t0.R.X == t1.R.X), meaning the constraint is about a single
 *      attribute compared across two tuple variables.
 *   3. There is at least one == predicate (the determinant columns X₁...Xₖ).
 *   4. There is exactly one <> predicate (the dependent column Y).
 *
 * This structural pattern corresponds to the composite FD (X₁,...,Xₖ) → Y.
 *
 * Reference: Chu et al. 2013, §2 — FDs are a special case of DCs.
 *
 * @returns The extracted FD, or null if the DC is not FD-shaped.
 */
export function extractFD(dc: DenialConstraint): FunctionalDependency | null {
  const determinant: string[] = [];
  let dependent: string | null = null;

  for (const pred of dc.predicates) {
    const leftCol = pred.left.columnName;
    const rightCol = pred.right.columnName;

    // Condition 2: same column on both sides
    if (leftCol !== rightCol) return null;

    if (pred.operator === "==") {
      // Condition 3: equality predicates form the determinant
      determinant.push(leftCol);
    } else if (pred.operator === "<>") {
      // Condition 4: exactly one inequality predicate
      if (dependent !== null) return null; // more than one <> → not an FD
      dependent = leftCol;
    } else {
      // Condition 1: order operator found → not an FD
      return null;
    }
  }

  // Conditions 3 and 4: must have at least one determinant and exactly one dependent
  if (determinant.length === 0 || dependent === null) return null;

  return {
    determinant,
    dependent,
    tableName: dc.predicates[0].left.tableName,
    sourceDC: dc,
  };
}

/**
 * Extract all FDs encoded in a list of DCs.
 *
 * Only DCs with zero violations on the target dataset (sound DCs) should be
 * passed here — JE requires the FD to actually hold on the data.
 *
 * @param dcs Parsed DenialConstraint objects (from DCParser).
 * @returns All FDs found; non-FD-shaped DCs are silently skipped.
 */
export function extractFDs(dcs: DenialConstraint[]): FunctionalDependency[] {
  const fds: FunctionalDependency[] = [];
  for (const dc of dcs) {
    const fd = extractFD(dc);
    if (fd !== null) fds.push(fd);
  }
  return fds;
}
