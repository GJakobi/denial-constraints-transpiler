/**
 * Denial Constraints to SQL Transpiler
 * 
 * This library provides tools to parse denial constraints and convert them
 * to SQL queries for violation detection.
 */

export { DCParser } from './parser';
export { DCTranspiler } from './transpiler';
export { 
  DenialConstraint, 
  Predicate, 
  TupleReference, 
  ComparisonOperator,
  SQLQuery,
  TranspilerOptions
} from './types';

import { DCParser } from './parser';
import { DCTranspiler } from './transpiler';
import { TranspilerOptions } from './types';

/**
 * Convenience function to transpile a denial constraint string to SQL
 */
export function transpileDC(dcString: string, options?: TranspilerOptions): string {
  const parser = new DCParser();
  const transpiler = new DCTranspiler(options);
  
  const dc = parser.parse(dcString);
  parser.validate(dc);
  
  return transpiler.transpile(dc);
}

/**
 * Convenience function to parse a denial constraint without transpiling
 */
export function parseDC(dcString: string) {
  const parser = new DCParser();
  return parser.parse(dcString);
}

