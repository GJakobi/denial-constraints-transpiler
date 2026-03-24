/**
 * loader.ts
 *
 * Loads a CSV file into a PostgreSQL table, inferring column types.
 * Designed to work with the datasets from DCValidity and similar benchmarks.
 */

import * as fs from "fs";
import * as readline from "readline";
import { Client } from "pg";
import { LoadCSVOptions } from "./types";

/**
 * Parse a CSV line, handling quoted fields correctly.
 */
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // escaped quote
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Sanitize a string to use as a PostgreSQL identifier (column / table name).
 * Lowercases and replaces non-alphanumeric characters with underscores.
 */
function sanitizeIdentifier(name: string): string {
  return name
    .replace(/\([^)]*\)$/, "") // strip trailing type annotation e.g. (String)
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/^[0-9]/, "_$&"); // identifiers cannot start with a digit
}

/**
 * Infer a PostgreSQL column type from a sample of values.
 * Falls back to TEXT for safety.
 */
function inferType(samples: string[]): string {
  const nonEmpty = samples.filter((s) => s !== "" && s.toLowerCase() !== "null");
  if (nonEmpty.length === 0) return "TEXT";

  const allInteger = nonEmpty.every((s) => /^-?\d+$/.test(s));
  if (allInteger) return "BIGINT";

  const allNumeric = nonEmpty.every((s) => /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s));
  if (allNumeric) return "DOUBLE PRECISION";

  return "TEXT";
}

/**
 * Load a CSV file into a PostgreSQL table.
 *
 * @param client   An open pg Client (caller is responsible for connect/end).
 * @param csvPath  Absolute path to the CSV file.
 * @param table    Target table name (will be sanitized).
 * @param options  Optional settings.
 * @returns        The number of rows inserted.
 */
export async function loadCSV(
  client: Client,
  csvPath: string,
  table: string,
  options: LoadCSVOptions = {}
): Promise<number> {
  const { dropIfExists = true, limit } = options;
  const safeTable = sanitizeIdentifier(table);

  // ── 1. Read all rows ────────────────────────────────────────────────────────
  const fileStream = fs.createReadStream(csvPath, "utf-8");
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const allLines: string[] = [];
  for await (const line of rl) {
    if (line.trim() !== "") allLines.push(line);
  }

  if (allLines.length < 2) {
    throw new Error(`CSV file has no data rows: ${csvPath}`);
  }

  const headers = parseCSVLine(allLines[0]);
  const safeHeaders = headers.map(sanitizeIdentifier);

  // Collect sample rows for type inference (scan the full file for reliability)
  const samples: string[][] = allLines
    .slice(1)
    .map(parseCSVLine);

  // ── 2. Infer column types ───────────────────────────────────────────────────
  const columnTypes: string[] = headers.map((_, colIdx) => {
    const colSamples = samples.map((row) => row[colIdx] ?? "");
    return inferType(colSamples);
  });

  // ── 3. Create table ─────────────────────────────────────────────────────────
  if (dropIfExists) {
    await client.query(`DROP TABLE IF EXISTS "${safeTable}"`);
  }

  const columnDefs = safeHeaders
    .map((col, i) => `"${col}" ${columnTypes[i]}`)
    .join(", ");

  await client.query(
    `CREATE TABLE IF NOT EXISTS "${safeTable}" (
       _row_id SERIAL PRIMARY KEY,
       ${columnDefs}
     )`
  );

  // ── 4. Insert rows in batches ───────────────────────────────────────────────
  const dataRows = allLines.slice(1);
  const maxRows = limit !== undefined ? Math.min(limit, dataRows.length) : dataRows.length;
  const BATCH = 500;
  let inserted = 0;

  for (let start = 0; start < maxRows; start += BATCH) {
    const batch = dataRows.slice(start, Math.min(start + BATCH, maxRows));
    if (batch.length === 0) break;

    // Build a multi-row INSERT: INSERT INTO t (c1,c2,...) VALUES ($1,$2,...),(...)
    const placeholders: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const line of batch) {
      const fields = parseCSVLine(line);
      const rowPlaceholders = safeHeaders.map(() => `$${paramIdx++}`);
      placeholders.push(`(${rowPlaceholders.join(", ")})`);

      for (let col = 0; col < safeHeaders.length; col++) {
        const raw = fields[col] ?? "";
        // Convert empty strings / "null" to actual NULL for numeric columns
        if ((raw === "" || raw.toLowerCase() === "null") &&
            columnTypes[col] !== "TEXT") {
          values.push(null);
        } else {
          values.push(raw === "" ? null : raw);
        }
      }
    }

    const cols = safeHeaders.map((h) => `"${h}"`).join(", ");
    await client.query(
      `INSERT INTO "${safeTable}" (${cols}) VALUES ${placeholders.join(", ")}`,
      values
    );
    inserted += batch.length;
  }

  console.log(
    `✓ Loaded ${inserted} rows into table "${safeTable}" from ${csvPath}`
  );
  console.log(
    `  Columns (${safeHeaders.length}): ${safeHeaders.join(", ")}`
  );
  return inserted;
}
