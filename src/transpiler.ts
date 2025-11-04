import { DenialConstraint, Predicate, ComparisonOperator, SQLQuery, TranspilerOptions } from './types';

/**
 * Transpiler that converts denial constraints to SQL queries
 */
export class DCTranspiler {
  private options: TranspilerOptions;

  constructor(options: TranspilerOptions = {}) {
    this.options = {
      selectAllColumns: false,
      formatOutput: true,
      includeComments: false,
      ...options
    };
  }

  /**
   * Convert a denial constraint to a SQL query
   */
  transpile(dc: DenialConstraint): string {
    const sqlQuery = this.buildSQLQuery(dc);
    return this.formatSQL(sqlQuery, dc);
  }

  /**
   * Build the SQL query structure
   */
  private buildSQLQuery(dc: DenialConstraint): SQLQuery {
    const tableName = this.extractTableName(dc);
    const tupleAliases = this.extractTupleAliases(dc);
    
    // Build SELECT clause
    const selectColumns = this.options.selectAllColumns
      ? tupleAliases.map(alias => `${alias}.*`)
      : this.buildSelectColumns(dc, tupleAliases);

    // Build FROM clause
    const fromClause = this.buildFromClause(tableName, tupleAliases);

    // Build WHERE clause
    const whereConditions = this.buildWhereConditions(dc);

    return {
      selectColumns,
      fromClause,
      whereConditions
    };
  }

  /**
   * Extract the table name from the denial constraint
   */
  private extractTableName(dc: DenialConstraint): string {
    return dc.predicates[0].left.tableName;
  }

  /**
   * Extract unique tuple aliases (t0, t1, etc.)
   */
  private extractTupleAliases(dc: DenialConstraint): string[] {
    const aliases = new Set<string>();
    dc.predicates.forEach(pred => {
      aliases.add(pred.left.tupleId);
      aliases.add(pred.right.tupleId);
    });
    return Array.from(aliases).sort();
  }

  /**
   * Build SELECT columns based on the predicates
   */
  private buildSelectColumns(dc: DenialConstraint, tupleAliases: string[]): string[] {
    // Extract all columns mentioned in predicates
    const columns = new Set<string>();
    
    dc.predicates.forEach(pred => {
      columns.add(pred.left.columnName);
      columns.add(pred.right.columnName);
    });

    // Create select columns for each tuple alias
    const selectColumns: string[] = [];
    tupleAliases.forEach(alias => {
      Array.from(columns).forEach(col => {
        selectColumns.push(`${alias}.${col}`);
      });
    });

    return selectColumns;
  }

  /**
   * Build the FROM clause with table and aliases
   */
  private buildFromClause(tableName: string, tupleAliases: string[]): string {
    // Clean table name (remove .csv extension if present)
    const cleanTableName = this.cleanTableName(tableName);
    
    return tupleAliases
      .map(alias => `${cleanTableName} ${alias}`)
      .join(', ');
  }

  /**
   * Clean table name (remove .csv extension, handle special characters)
   */
  private cleanTableName(tableName: string): string {
    let cleaned = tableName;
    
    // Remove .csv extension
    if (cleaned.endsWith('.csv')) {
      cleaned = cleaned.slice(0, -4);
    }

    // If table name contains special characters, quote it
    if (/[.-]/.test(cleaned)) {
      cleaned = `"${cleaned}"`;
    }

    return cleaned;
  }

  /**
   * Build WHERE conditions from predicates
   */
  private buildWhereConditions(dc: DenialConstraint): string[] {
    return dc.predicates.map(pred => this.predicateToSQL(pred));
  }

  /**
   * Convert a single predicate to SQL condition
   */
  private predicateToSQL(pred: Predicate): string {
    const leftSide = `${pred.left.tupleId}.${pred.left.columnName}`;
    const rightSide = `${pred.right.tupleId}.${pred.right.columnName}`;
    const sqlOperator = this.convertOperator(pred.operator);

    return `${leftSide} ${sqlOperator} ${rightSide}`;
  }

  /**
   * Convert DC operator to SQL operator
   */
  private convertOperator(op: ComparisonOperator): string {
    const mapping: Record<ComparisonOperator, string> = {
      '==': '=',
      '<>': '!=',
      '<=': '<=',
      '>=': '>=',
      '<': '<',
      '>': '>'
    };

    return mapping[op];
  }

  /**
   * Format the SQL query string
   */
  private formatSQL(sqlQuery: SQLQuery, dc: DenialConstraint): string {
    const lines: string[] = [];

    // Add comment if requested
    if (this.options.includeComments) {
      lines.push('-- Denial Constraint Violation Query');
      lines.push('-- Generated from: ¬(' + 
        dc.predicates.map(p => 
          `${p.left.tupleId}.${p.left.columnName} ${p.operator} ${p.right.tupleId}.${p.right.columnName}`
        ).join(' ^ ') + ')');
      lines.push('');
    }

    if (this.options.formatOutput) {
      // Formatted output
      lines.push('SELECT');
      lines.push('  ' + sqlQuery.selectColumns.join(',\n  '));
      lines.push('FROM');
      lines.push('  ' + sqlQuery.fromClause);
      lines.push('WHERE');
      lines.push('  ' + sqlQuery.whereConditions.join('\n  AND '));
      lines.push(';');
    } else {
      // Single line output
      const sql = `SELECT ${sqlQuery.selectColumns.join(', ')} ` +
                  `FROM ${sqlQuery.fromClause} ` +
                  `WHERE ${sqlQuery.whereConditions.join(' AND ')};`;
      lines.push(sql);
    }

    return lines.join('\n');
  }
}

