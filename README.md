# Denial Constraints Transpiler

A transpiler that converts **Denial Constraints (DCs)** into executable SQL queries and runs them against a PostgreSQL database to detect integrity constraint violations.

This project is part of the undergraduate thesis *"From Discovery to Execution: A Denial Constraints Transpiler to SQL with Relational Database Integration"* — Gustavo Jakobi, BCC/UFPR, 2026.

---

## What are Denial Constraints?

A Denial Constraint (DC) is an integrity constraint expressed in first-order logic stating that no pair of tuples in a relation can simultaneously satisfy a given set of predicates [Chu et al., 2013]:

```
φ : ∀ t, t' ∈ r, ¬(p₁ ∧ p₂ ∧ ... ∧ pₘ)
```

DCs unify several classical constraint types (functional dependencies, unique column combinations, order dependencies) under a single formalism.

### Syntax used in this project

```
¬(t0.tablename.column op t1.tablename.column ^ ...)
```

| Symbol | Meaning |
|--------|---------|
| `¬` | Denial (negation of the predicate conjunction) |
| `^` | Conjunction (AND) |
| `t0`, `t1` | Two tuple variables ranging over the same table |
| `==` `<>` `<` `<=` `>` `>=` | Comparison operators |

**Example — same zip code must imply same state (from tax500k dataset):**
```
¬(t0.tax500k.zip == t1.tax500k.zip ^ t0.tax500k.state <> t1.tax500k.state)
```

**Generated SQL:**
```sql
SELECT t0.*, t1.*
FROM tax500k t0, tax500k t1
WHERE t0.zip = t1.zip
  AND t0.state <> t1.state
  AND t0._row_id < t1._row_id
```

---

## Benchmark Datasets

Datasets and pre-discovered Sound DCs come from the **DCValidity** repository:

> NoSocAlgroc. *DCValidity: How and Why False Denial Constraints are Discovered*. GitHub, 2024.
> https://github.com/nosocalgroc/DCValidity

The pre-converted DC files in `examples/dcs/` were generated from the `soundDCs/` folder of that repository using `src/convert-dcs.ts`. The original DCValidity format uses type annotations (`ColumnName(Type)`) and no table name; the converter strips types, lowercases column names, and injects the table name.

---

## Quick Start (Docker — one command)

**Requirements:** [Docker](https://www.docker.com/), [Node.js >= 18](https://nodejs.org/)

```bash
# 1. Clone this repository
git clone <repo-url>
cd denial-constraints-transpiler

# 2. Install npm dependencies
npm install

# 3. Run the full demo (downloads data, starts PostgreSQL, runs DCs)
npm run demo
```

This will:
1. Start a PostgreSQL instance via Docker Compose
2. Download the `airport` dataset from DCValidity (~5 MB)
3. Load the dataset into PostgreSQL
4. Run the 2 pre-converted Sound DCs against it
5. Print the violations found

To run the larger `tax500k` dataset (34 MB, uses first 15 000 rows as in the paper):
```bash
npm run demo:tax
```

---

## Manual Setup

### 1. Start PostgreSQL

```bash
docker compose up -d
```

Or use an existing PostgreSQL instance by setting the standard `PG*` environment variables:
```bash
export PGHOST=localhost PGPORT=5432 PGDATABASE=dctest PGUSER=postgres PGPASSWORD=postgres
```

### 2. Download benchmark data

```bash
npm run download-data                    # all datasets
npm run download-data -- airport         # only airport
npm run download-data -- tax500k         # only tax500k
```

Data is saved to `data/datasets/` and `data/soundDCs/`.

### 3. Convert DCs from DCValidity format (optional)

The `examples/dcs/` files are already converted. To convert another dataset from DCValidity:

```bash
npm run convert-dcs -- \
  --input  data/soundDCs/flights \
  --table  flights \
  --output examples/dcs/flights.txt
```

**DCValidity format:** `¬(t0.ColumnName(Type) op t1.ColumnName(Type) ^ ...)`
**Transpiler format:** `¬(t0.tablename.columnname op t1.tablename.columnname ^ ...)`

### 4. Run DCs against the database

```bash
npm run run-dcs -- \
  --csv     data/datasets/airport.csv \
  --table   airport \
  --dcs     examples/dcs/airport.txt \
  --verbose
```

**CLI flags:**

| Flag | Description | Default |
|------|-------------|---------|
| `--csv <path>` | CSV file to load into the database | - |
| `--table <name>` | Table name to create in PostgreSQL | - |
| `--dcs <path>` | File with one DC per line | - |
| `--dc "<dc>"` | Single DC string passed directly | - |
| `--limit <n>` | Load only the first N rows of the CSV | all |
| `--verbose` | Print generated SQL and violations | false |
| `--host` | PostgreSQL host | localhost |
| `--port` | PostgreSQL port | 5432 |
| `--db` | Database name | dctest |
| `--user` | PostgreSQL user | postgres |
| `--pass` | PostgreSQL password | "" |

---

## Project Structure

```
denial-constraints-transpiler/
├── src/
│   ├── grammar.ohm        # Formal DC grammar (Ohm.js)
│   ├── parser.ts          # DC parser — builds an AST from a DC string
│   ├── transpiler.ts      # Converts AST to SQL violation-detection queries
│   ├── runner.ts          # Executes generated SQL against PostgreSQL
│   ├── loader.ts          # Loads CSV files into PostgreSQL tables
│   ├── convert-dcs.ts     # Converts DCValidity format to transpiler format
│   ├── run-dcs.ts         # CLI entrypoint
│   ├── examples.ts        # In-memory transpilation examples (no DB needed)
│   ├── index.ts           # Library exports
│   └── types.ts           # TypeScript type definitions
├── examples/
│   └── dcs/
│       ├── airport.txt    # Sound DCs for airport (converted from DCValidity)
│       └── tax500k.txt    # Sound DCs for tax500k (converted from DCValidity)
├── scripts/
│   ├── demo.sh            # End-to-end demo script
│   └── download-data.sh   # Downloads datasets from DCValidity
├── docker-compose.yml     # PostgreSQL 16 service definition
├── package.json
└── tsconfig.json
```

---

## Library API

```typescript
import { transpileDC, DCRunner } from './src/index';

// Transpile a DC to SQL (no database needed)
const sql = transpileDC(
  '¬(t0.tax500k.zip == t1.tax500k.zip ^ t0.tax500k.state <> t1.tax500k.state)'
);
console.log(sql);

// Run a DC against PostgreSQL and retrieve violations
const runner = new DCRunner({
  host: 'localhost', port: 5432,
  database: 'dctest', user: 'postgres', password: 'postgres'
});
const result = await runner.runDC('¬(t0.airport.ident == t1.airport.ident)');
console.log(result.violationCount, result.violations);
```

---

## npm Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run demo` | Full end-to-end demo with airport dataset |
| `npm run demo:tax` | Full end-to-end demo with tax500k dataset |
| `npm run download-data` | Download all DCValidity datasets |
| `npm run run-dcs` | Run DCs via CLI (see flags above) |
| `npm run convert-dcs` | Convert DCValidity DC file to transpiler format |
| `npm run examples` | Transpile example DCs to SQL (no DB needed) |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run clean` | Remove compiled output |

---

## References

- Chu, X., Ilyas, I. F., & Papotti, P. (2013). Discovering Denial Constraints. *Proceedings of the VLDB Endowment*, 6(13), 1498-1509.
- NoSocAlgroc (2024). *DCValidity: How and Why False Denial Constraints are Discovered*. https://github.com/nosocalgroc/DCValidity
- Martinenghi, D. (2025). Simplified SQL for Denial Constraint Checking.
- Pena, L. et al. (2023). Mind Your Dependencies: DC-Based Query Optimization.
- Pena, L. et al. (2021). FACET: Fast Approximate DC violation dEtecTion.
