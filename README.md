# Denial Constraints to SQL Transpiler

A TypeScript-based transpiler that converts denial constraints (DCs) to SQL queries for data quality validation. This project is part of a final thesis on data consistency and integrity.

## Overview

Denial constraints are a powerful formalism for expressing data dependencies and business rules. They generalize many traditional database constraints including:

- Functional Dependencies (FDs)
- Unique Constraints
- Order Dependencies
- Complex Business Rules

This transpiler parses denial constraints and generates SQL self-join queries that can detect violations of these constraints.

## Background

Denial constraints express invalid states of data using predicates over tuple pairs. A DC has the form:

```
φ: ∀t, t' ∈ r, ¬(p₁ ∧ p₂ ∧ ... ∧ pₘ)
```

Where each predicate `pᵢ` compares attributes between tuples using operators: `=`, `≠`, `<`, `≤`, `>`, `≥`

### Example

The business rule "an employee with more hours worked should not receive a lower bonus than another employee with the same role" can be expressed as:

```
¬(t₀.Role = t₁.Role ∧ t₀.Hours > t₁.Hours ∧ t₀.Bonus < t₁.Bonus)
```

## Features

- ✅ **Formal Grammar**: Closed grammar definition using Ohm.js
- ✅ **Type-Safe**: Full TypeScript implementation with type definitions
- ✅ **Standards-Compliant**: Generates standard SQL queries
- ✅ **Flexible Output**: Formatted or compact SQL output
- ✅ **Well-Tested**: Examples based on real datasets and research papers

## Installation

```bash
npm install
```

## Usage

### Basic Example

```typescript
import { transpileDC } from './src/index';

const dc = '¬(t0.hours.Role==t1.hours.Role^t0.hours.Hours>t1.hours.Hours^t0.hours.Bonus<t1.hours.Bonus)';
const sql = transpileDC(dc);

console.log(sql);
```

Output:
```sql
SELECT
  t0.Role, t0.Hours, t0.Bonus,
  t1.Role, t1.Hours, t1.Bonus
FROM
  hours t0, hours t1
WHERE
  t0.Role = t1.Role
  AND t0.Hours > t1.Hours
  AND t0.Bonus < t1.Bonus
;
```

### Advanced Usage

```typescript
import { DCParser, DCTranspiler } from './src/index';

// Parse the DC
const parser = new DCParser();
const dc = parser.parse('¬(t0.employees.ID==t1.employees.ID)');

// Validate
parser.validate(dc);

// Transpile with options
const transpiler = new DCTranspiler({
  formatOutput: true,
  includeComments: true,
  selectAllColumns: false
});

const sql = transpiler.transpile(dc);
```

## Grammar Specification

The transpiler uses a **formal, closed grammar** for denial constraints. For the complete formal specification including EBNF notation, semantics, and theoretical properties, see [`docs/grammar-specification.md`](docs/grammar-specification.md).

### Quick Reference (Ohm.js syntax)

```
DenialConstraint {
  DenialConstraint = "¬" "(" PredicateList ")"
  PredicateList    = Predicate ("^" Predicate)*
  Predicate        = TupleRef operator TupleRef
  TupleRef         = identifier "." tableName "." columnName
  operator         = "==" | "<>" | "<=" | ">=" | "<" | ">"
  tableName        = qualifiedName
  columnName       = qualifiedName
  qualifiedName    = (alnum | "_" | "." | "-")+
  identifier       = "t" digit+
}
```

### Grammar Elements

- **¬**: Negation symbol (U+00AC)
- **^**: Conjunction (AND) operator
- **Operators**: `==` (equal), `<>` (not equal), `<=`, `>=`, `<`, `>`
- **Tuple identifiers**: `t0`, `t1`, `t2`, ...
- **Table/Column names**: Support alphanumeric, underscore, dot, hyphen

### Documentation for Thesis

- **Formal Specification**: See [`docs/grammar-specification.md`](docs/grammar-specification.md) for EBNF notation, formal semantics, and examples
- **Thesis Notes**: See [`docs/thesis-notes.md`](docs/thesis-notes.md) for guidance on presenting the grammar in your TCC

## Input Format

Denial constraints should follow this format:

```
¬(t0.TableName.Column1 op t1.TableName.Column2 ^ t0.TableName.Column3 op t1.TableName.Column4)
```

### Examples from DCFinder

These examples are from real DC discovery algorithms:

```
¬(t0.WDC_planets.csv.OrbitalRadius==t1.WDC_planets.csv.OrbitalRadius)
¬(t0.WDC_planets.csv.Rings<>t1.WDC_planets.csv.Rings^t0.WDC_planets.csv.Type==t1.WDC_planets.csv.Type)
¬(t0.airport.Country==t1.airport.Country^t0.airport.Timezone<>t1.airport.Timezone)
```

## Running Examples

Run the example transpilations:

```bash
npm run test
```

This will transpile several example DCs from research papers and show the generated SQL.

## Building

Compile TypeScript to JavaScript:

```bash
npm run build
```

This creates the `dist/` directory with compiled JavaScript and type definitions.

## Project Structure

```
denial-constraints-transpiler/
├── src/
│   ├── grammar.ohm         # Ohm.js grammar definition
│   ├── types.ts            # TypeScript type definitions
│   ├── parser.ts           # DC parser using Ohm.js
│   ├── transpiler.ts       # SQL transpiler logic
│   ├── index.ts            # Main entry point
│   └── examples.ts         # Example usage
├── docs/
│   ├── grammar-specification.md  # Formal grammar spec (EBNF + semantics)
├── package.json
├── tsconfig.json
├── LICENSE
└── README.md
```

## Theoretical Foundation

This transpiler is based on research in data dependencies and quality:

1. **Denial Constraints**: Generalizes functional dependencies, unique constraints, and order dependencies
2. **Violation Detection**: Self-join queries expose tuple pairs that violate constraints
3. **Data Cleaning**: Violations indicate potential data quality issues

### Key References

- Pena et al. (2020) - "Efficient Detection of Data Dependency Violations" (CIKM)
- Chu et al. (2013) - "Discovering Denial Constraints" (VLDB)
- Bleifuß et al. (2017) - "Approximate Discovery of Functional Dependencies" (CIKM)

## SQL Output Characteristics

The generated SQL queries have these properties:

- **Self-joins**: Compares tuples from the same table
- **WHERE clause**: Directly translates DC predicates
- **SELECT clause**: Returns columns involved in violations

## Transpiler Options

```typescript
interface TranspilerOptions {
  selectAllColumns?: boolean;   // Select all columns vs. only referenced ones
  formatOutput?: boolean;        // Pretty-print vs. compact
  includeComments?: boolean;     // Add explanatory comments
}
```

<!-- ## Future Work

Potential extensions for the thesis:

- [ ] Support for constants in predicates (e.g., `t0.Age > 18`)
- [ ] Multi-table DCs (cross-table constraints)
- [ ] Approximate DCs with error thresholds
- [ ] Query optimization hints
- [ ] Integration with DC discovery algorithms (DCFinder, FastDC)
- [ ] Support for NULL handling
- [ ] Batch processing of multiple DCs
- [ ] Performance benchmarking framework -->

## License

MIT License - See LICENSE file for details

## Author

Gustavo Jakobi - Federal University of Paraná (UFPR)
Advisor: Prof. Eduardo Cunha de Almeida

## Acknowledgments

This project is developed as part of a final thesis (TCC) on data quality and integrity constraints, supervised by Prof. Eduardo Almeida at UFPR.
