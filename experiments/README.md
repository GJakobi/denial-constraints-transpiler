# Experiments

End-to-end scripts that reproduce the experimental chapter (Chapter 4) of the
TCC thesis *"A Denial-Constraint-to-SQL Transpiler with Semantic Query
Optimization"* (UFPR/BCC, 2026). The scripts cover four research questions:

| RQ | Question | Driver |
|---|---|---|
| RQ1 | Does the transpiler agree with FACET on every supported DC? | `run-experiment-server.sh` + `run-k-trials.sh` |
| RQ2 | What is the performance gap vs FACET? | same scripts as RQ1; timing is the by-product |
| RQ3.1 | How does the transpiler scale with dataset size? | `run-rq3.sh` + `run-k-trials-rq3.sh` |
| RQ3.2 | How does the transpiler scale with concurrent SQL submissions? | `run-k-trials-rq3-concurrent.sh` |

The scripts are deliberately self-contained: each driver loops over its
configuration, calls the transpiler and (for RQ1–3.1) FACET, writes raw
per-DC outputs, and emits an aggregated summary. All numerical results
reported in the thesis are reproducible by running the corresponding driver
on a clean machine, given the prerequisites below.

## Directory layout

```
experiments/
├── README.md                           (this file)
├── run-experiment-server.sh            RQ1/RQ2 driver (serra2 path)
├── run-experiment.sh                   RQ1/RQ2 driver (local laptop via Docker)
├── run-k-trials.sh                     wraps run-experiment-server.sh, k trials per dataset
├── run-rq3.sh                          RQ3.1 driver (data-size scalability)
├── run-k-trials-rq3.sh                 wraps run-rq3.sh, k trials per (DC, size)
├── run-k-trials-rq3-concurrent.sh      RQ3.2 driver (concurrency scalability)
├── aggregate-trials.js                 produces aggregated_<dataset>.{json,md} for RQ1/RQ2
├── aggregate-trials-rq3.js             aggregator for RQ3.1
├── aggregate-trials-rq3-concurrent.js  aggregator for RQ3.2
├── compare.js                          transpiler-vs-FACET diff (with optional ground truth)
├── convert-to-facet.js                 transpiler DC syntax → FACET CSV input format
├── convert-holoclean-dcs.js            HoloClean Hospital DCs → transpiler syntax
├── prepare-dataset.js                  DCValidity CSV → FACET CSV (drops _row_id if present)
├── inject-violations.js                controlled violation injection for RQ3.1
├── analyze-timing.js                   FACET internal-phase breakdown analysis (Fig 4.1)
├── setup-server.sh                     one-time server bootstrap
├── holoclean-hospital/                 HoloClean Hospital benchmark assets
└── test/                               small fixtures for the conversion utilities
```

Outputs (gitignored, regenerable):

```
experiments/
├── results/                            run-experiment-server.sh, run-rq3.sh
├── results-k-trials/                   run-k-trials.sh
├── results-k-trials-rq3/               run-k-trials-rq3.sh (tax500k)
├── results-k-trials-rq3-Hospital/      run-k-trials-rq3.sh (Hospital)
├── results-k-trials-rq3-concurrent-clean/    RQ3.2, intra-query off
└── results-k-trials-rq3-concurrent-tuned/    RQ3.2, intra-query on, PG cap raised
```

## Prerequisites

- **Node.js 18+** and **npm** (the transpiler is TypeScript; the drivers shell out to `npx ts-node`).
- **PostgreSQL 14+**, accessible to the current user. The drivers pick up `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` from the environment; the defaults are `localhost:5432`, current user, password `""`, database `dctest`.
- **Java 11+** (FACET runs on the JVM). Only needed for RQ1–3.1; RQ3.2 is transpiler-only.
- **FACET JAR** at `../similarity-facet/target/facet-jar-with-dependencies.jar` (one level up from the transpiler repo). Override with `FACET_JAR=/path/to/facet.jar`. The companion repository is at <https://github.com/leoluciano/similarity-facet>.
- For the local laptop path only: **Docker** + the bundled `docker-compose.yml`. The serra2 scripts run against a native PG and never use Docker.

## Quick start (local, Docker PG)

```bash
# from the transpiler repo root
docker compose up -d --wait
DATASET=hospital_hc bash experiments/run-experiment.sh
node experiments/compare.js \
  --transpiler experiments/results/hospital_hc/transpiler \
  --facet      experiments/results/hospital_hc/facet \
  --dcs        examples/dcs/hospital_hc.txt
```

## RQ1/RQ2 — correctness + sequential performance

```bash
# Single trial (one dataset)
bash experiments/run-experiment-server.sh Hospital

# k trials, multiple datasets (the production setup)
bash experiments/run-k-trials.sh 5 tax500k Hospital hospital_hc
# Aggregator runs automatically at the end of each dataset; output:
#   experiments/results-k-trials/aggregated_<dataset>.{json,md}
```

## RQ3.1 — data-size scalability

```bash
# tax500k (default): sound DCs, controlled injection
DATASET=tax500k INJECT=1 bash experiments/run-k-trials-rq3.sh 5

# Hospital (naturally dirty, no injection)
DATASET=Hospital INJECT=0 bash experiments/run-k-trials-rq3.sh 5

node experiments/aggregate-trials-rq3.js \
  --base experiments/results-k-trials-rq3-Hospital --k 5
```

## RQ3.2 — concurrency scalability

Two sweeps are reported: a *clean* sweep (intra-query parallelism disabled per
session via `SET max_parallel_workers_per_gather = 0` on each backend) and a
*tuned* sweep (intra-query at default, PostgreSQL's global cap raised so
intra-query workers are always available). The clean sweep isolates
inter-session concurrency as the sole independent variable; the tuned sweep
characterises a properly-provisioned production deployment.

```bash
# Clean: intra-query disabled, just inter-session concurrency
MODE=clean DATASET=Hospital SIZE=100000 K=5 \
  CONCURRENCIES="1 2 4 8 16 24 32" \
  bash experiments/run-k-trials-rq3-concurrent.sh

# Tuned: requires postgresql.conf
#   max_parallel_workers = 64
#   max_worker_processes = 80
# then restart PG, then:
MODE=tuned DATASET=Hospital SIZE=100000 K=5 \
  bash experiments/run-k-trials-rq3-concurrent.sh

# Aggregate either sweep:
node experiments/aggregate-trials-rq3-concurrent.js \
  --base experiments/results-k-trials-rq3-concurrent-clean/Hospital-100000 --k 5
```

The script verifies the per-backend `max_parallel_workers_per_gather` setting
via `SHOW` before measurement, and for `MODE=tuned` it aborts with a config
snippet if `max_parallel_workers < 2 * max(CONCURRENCIES)`.

## Methodology notes

- **k=5 trials, mean ± sample stdev (Bessel-corrected), CV = σ/μ.** A CV under 5% is treated as negligible variance; CV above 15% flags that more trials might be warranted.
- **Warm cache.** Each RQ3.2 trial runs one discarded warm-up batch before the measured batch, so all reported numbers reflect steady-state PostgreSQL with the working set in `shared_buffers` and the OS page cache.
- **Memory cap.** All runs were executed under `ulimit -v 32000000` (32 GB virtual memory cap) on the shared serra2 server.
- **FACET single-DC mode.** FACET is invoked once per constraint, the methodology of the original FACET paper. This pays the CSV reload cost on every invocation and is the cost-breakdown reported in §4.4 of the thesis.
- **Correctness sanity.** `compare.js` normalises both tools' output to unordered pairs and reports MATCH / MISMATCH / FACET-UNSUPPORTED per DC. The RQ3.1 driver additionally consumes an `injected.json` ground-truth file (when injection is enabled) and verifies that every planted violation appears in both tools' outputs.
