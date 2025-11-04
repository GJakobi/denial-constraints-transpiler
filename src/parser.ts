import * as ohm from "ohm-js";
import * as fs from "fs";
import * as path from "path";
import {
  DenialConstraint,
  Predicate,
  TupleReference,
  ComparisonOperator,
} from "./types";

/**
 * Parser for denial constraints using Ohm.js
 */
export class DCParser {
  private grammar: ohm.Grammar;
  private semantics: ohm.Semantics;

  constructor() {
    const grammarPath = path.join(__dirname, "grammar.ohm");
    const grammarContent = fs.readFileSync(grammarPath, "utf-8");
    this.grammar = ohm.grammar(grammarContent);
    this.semantics = this.createSemantics();
  }

  /**
   * Parse a denial constraint string into a structured AST
   */
  parse(dcString: string): DenialConstraint {
    const match = this.grammar.match(dcString);

    if (match.failed()) {
      throw new Error(`Parse error: ${match.message}`);
    }

    return this.semantics(match).eval();
  }

  /**
   * Create semantic actions for the grammar
   */
  private createSemantics(): ohm.Semantics {
    const semantics = this.grammar.createSemantics();

    semantics.addOperation<any>("eval", {
      DenialConstraint(_neg, _lparen, predicateList, _rparen) {
        return {
          predicates: predicateList.eval(),
        } as DenialConstraint;
      },

      PredicateList(firstPredicate, _caret, restPredicates) {
        const predicates = [firstPredicate.eval()];
        restPredicates.children.forEach((pred: any) => {
          predicates.push(pred.eval());
        });
        return predicates;
      },

      Predicate(leftRef, operator, rightRef) {
        return {
          left: leftRef.eval(),
          operator: operator.sourceString as ComparisonOperator,
          right: rightRef.eval(),
        } as Predicate;
      },

      TupleRef(identifier, _dot1, tableName, _dot2, columnName) {
        return {
          tupleId: identifier.sourceString,
          tableName: tableName.sourceString,
          columnName: columnName.sourceString,
        } as TupleReference;
      },

      qualifiedName(chars) {
        return chars.sourceString;
      },

      identifier(_t, digits) {
        return "t" + digits.sourceString;
      },
    });

    return semantics;
  }

  /**
   * Validate that a denial constraint is well-formed
   */
  validate(dc: DenialConstraint): boolean {
    if (!dc.predicates || dc.predicates.length === 0) {
      throw new Error("Denial constraint must have at least one predicate");
    }

    // Check that all predicates reference the same table
    const tableNames = new Set<string>();
    dc.predicates.forEach((pred) => {
      tableNames.add(pred.left.tableName);
      tableNames.add(pred.right.tableName);
    });

    if (tableNames.size !== 1) {
      throw new Error("All predicates must reference the same table");
    }

    return true;
  }
}
