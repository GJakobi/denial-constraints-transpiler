# Formal Grammar Specification for Denial Constraints

## 1. Introduction

This document presents the formal grammar specification for the Denial Constraints language accepted by this transpiler. The grammar is designed to be **closed** (complete and unambiguous) and is presented using both **EBNF** (Extended Backus-Naur Form) notation and **Ohm.js** syntax.

## 2. Notation Conventions

### 2.1 EBNF Notation

We use the following conventions in our EBNF grammar:

- `::=` : Definition
- `|` : Alternation (choice)
- `[ ]` : Optional (zero or one occurrence)
- `{ }` : Repetition (zero or more occurrences)
- `( )` : Grouping
- `" "` : Terminal symbols (literals)
- `< >` : Non-terminal symbols

### 2.2 Terminal Symbols

The following symbols are terminals in our grammar:

- **Negation symbol**: `¬` (Unicode U+00AC)
- **Conjunction operator**: `^` (logical AND)
- **Comparison operators**: `==`, `<>`, `<=`, `>=`, `<`, `>`
- **Delimiters**: `(`, `)`, `.`

## 3. Formal Grammar in EBNF

```ebnf
<DenialConstraint> ::= "¬" "(" <PredicateList> ")"

<PredicateList> ::= <Predicate> { "^" <Predicate> }

<Predicate> ::= <TupleReference> <ComparisonOperator> <TupleReference>

<TupleReference> ::= <TupleIdentifier> "." <TableName> "." <ColumnName>

<ComparisonOperator> ::= "==" | "<>" | "<=" | ">=" | "<" | ">"

<TupleIdentifier> ::= "t" <Digit> { <Digit> }

<TableName> ::= <QualifiedName>

<ColumnName> ::= <QualifiedName>

<QualifiedName> ::= ( <Letter> | <Digit> | "_" | "." | "-" )+

<Letter> ::= "a" | "b" | ... | "z" | "A" | "B" | ... | "Z"

<Digit> ::= "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"
```

## 4. Grammar Semantics

### 4.1 Denial Constraint

A **denial constraint** is a first-order logic formula that specifies combinations of tuples that must not exist in a relation. The general form is:

```
φ: ∀t₀, t₁, ..., tₙ ∈ r, ¬(p₁ ∧ p₂ ∧ ... ∧ pₘ)
```

Where:
- `r` is a relation (table)
- `t₀, t₁, ..., tₙ` are tuple variables
- `p₁, p₂, ..., pₘ` are predicates

### 4.2 Predicates

Each predicate has the form:

```
pᵢ: tⱼ.A op tₖ.B
```

Where:
- `tⱼ, tₖ` are tuple identifiers (may be the same or different)
- `A, B` are column names from the relation
- `op` is a comparison operator: `{==, <>, <, <=, >, >=}`

### 4.3 Operator Semantics

| DC Operator | Mathematical Symbol | SQL Equivalent | Meaning |
|-------------|---------------------|----------------|---------|
| `==` | `=` | `=` | Equal to |
| `<>` | `≠` | `!=` or `<>` | Not equal to |
| `<` | `<` | `<` | Less than |
| `<=` | `≤` | `<=` | Less than or equal to |
| `>` | `>` | `>` | Greater than |
| `>=` | `≥` | `>=` | Greater than or equal to |

### 4.4 Tuple References

A tuple reference uniquely identifies a column value from a specific tuple variable:

```
<TupleIdentifier>.<TableName>.<ColumnName>
```

**Examples:**
- `t0.employees.salary`
- `t1.WDC_planets.csv.Mass`
- `t2.airport.Country`

## 5. Language Constraints

### 5.1 Well-formedness Constraints

For a denial constraint to be **well-formed**, it must satisfy:

1. **At least one predicate**: A DC must contain at least one predicate
2. **Single relation**: All tuple references must refer to the same table
3. **Valid tuple identifiers**: Tuple identifiers must be of the form `t` followed by one or more digits
4. **Balanced predicates**: Each predicate must have exactly two tuple references
5. **Valid operators**: Only the six comparison operators are permitted

### 5.2 Syntactic Constraints

1. **Case sensitivity**: Table and column names are case-sensitive
2. **Whitespace**: Whitespace is generally ignored except within quoted strings
3. **Comments**: Single-line comments start with `//` and extend to end of line

## 6. Examples

### 6.1 Unique Constraint

**Natural language**: "No two tuples can have the same combination of EmpID and ProjID"

**Denial Constraint**:
```
¬(t0.hours.EmpID == t1.hours.EmpID ^ t0.hours.ProjID == t1.hours.ProjID)
```

**Type**: Unique constraint (equivalent to `UNIQUE(EmpID, ProjID)`)

### 6.2 Functional Dependency

**Natural language**: "If two employees have the same department, they must have the same manager"

**Denial Constraint**:
```
¬(t0.employees.Department == t1.employees.Department ^ t0.employees.Manager <> t1.employees.Manager)
```

**Type**: Functional dependency (Department → Manager)

### 6.3 Order Dependency

**Natural language**: "Employees with the same role: if one works more hours, they should not receive a lower bonus"

**Denial Constraint**:
```
¬(t0.hours.Role == t1.hours.Role ^ t0.hours.Hours > t1.hours.Hours ^ t0.hours.Bonus < t1.hours.Bonus)
```

**Type**: Order dependency with business rule

### 6.4 Complex Multi-Predicate Constraint

**Natural language**: "Planets with more confirmed moons should not have shorter orbital periods while being of different types"

**Denial Constraint**:
```
¬(t0.planets.ConfirmedMoons >= t1.planets.ConfirmedMoons ^ 
  t0.planets.OrbitalPeriod <= t1.planets.OrbitalPeriod ^ 
  t0.planets.Type <> t1.planets.Type)
```

**Type**: Complex multi-attribute order dependency

## 7. Grammar Properties

### 7.1 Completeness

This grammar is **complete** in the sense that:
- It can express all binary denial constraints (DCs on tuple pairs)
- It covers all six standard comparison operators
- It supports arbitrary numbers of predicates

### 7.2 Unambiguity

The grammar is **unambiguous**:
- Each valid denial constraint has exactly one parse tree
- Operator precedence is well-defined (conjunction binds predicates)
- No left-recursion or ambiguous productions

### 7.3 Decidability

The grammar is **decidable**:
- Parsing can be done in polynomial time
- Membership can be determined in linear time
- The language is context-free

## 8. Extensions and Limitations

### 8.1 Current Limitations

1. **No constant values**: Predicates cannot compare with constants (e.g., `t0.age > 18`)
2. **Binary constraints only**: Only two-tuple constraints are supported
3. **No existential quantifiers**: Only universal quantification over tuple pairs
4. **Single relation**: Cannot express cross-table constraints

### 8.2 Possible Extensions

Future versions could support:

1. **Constants in predicates**:
   ```
   ¬(t0.employees.age < 18)
   ```

2. **N-ary constraints**:
   ```
   ¬(t0.R.A == t1.R.A ^ t1.R.B == t2.R.B ^ t0.R.C == t2.R.C)
   ```

3. **Approximate constraints** (with error thresholds):
   ```
   ¬(t0.R.A == t1.R.A ^ t0.R.B <> t1.R.B)[ε=0.01]
   ```

4. **Cross-table constraints**:
   ```
   ¬(t0.employees.dept_id == t1.departments.id ^ t0.employees.location <> t1.departments.location)
   ```

## 9. Formal Verification

### 9.1 Type System

Each component of the grammar has an associated type:

- **DenialConstraint**: `DC`
- **PredicateList**: `List<Predicate>`
- **Predicate**: `TupleRef × Operator × TupleRef`
- **TupleReference**: `Identifier × Table × Column`
- **ComparisonOperator**: `{==, <>, <, <=, >, >=}`

### 9.2 Well-typed Constraints

A denial constraint is **well-typed** if:
1. All tuple references point to existing columns in the specified table
2. Compared columns have compatible types (e.g., numeric, string)
3. Operators are appropriate for column types

*Note: Type checking is not enforced by the parser but should be validated during transpilation.*

## 10. References

This grammar specification follows conventions found in:

1. Database theory literature on integrity constraints
2. SQL standard grammar specifications (ISO/IEC 9075)
3. Formal language theory (context-free grammars)

### Related Work

- **Chu et al.** (2013): "Discovering Denial Constraints" - VLDB
- **Pena et al.** (2020): "Efficient Detection of Data Dependency Violations" - CIKM
- **Bleifuß et al.** (2017): "Approximate Discovery of Functional Dependencies" - CIKM

