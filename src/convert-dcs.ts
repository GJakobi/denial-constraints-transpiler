/**
 * convert-dcs.ts
 *
 * Converts Denial Constraints from DCValidity format to the format expected
 * by the denial-constraints-transpiler.
 *
 * DCValidity format  : ¬(t0.ColumnName(Type) op t1.ColumnName(Type) ^ ...)
 * Transpiler format  : ¬(t0.tablename.columnname op t1.tablename.columnname ^ ...)
 *
 * Source of DC files: https://github.com/nosocalgroc/DCValidity
 *
 * Usage:
 *   npx ts-node src/convert-dcs.ts \
 *     --input  path/to/DCValidity/soundDCs/airport \
 *     --table  airport \
 *     --output examples/dcs/airport.txt
 */

import * as fs from "fs";
import * as path from "path";

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface Args {
  input: string;
  table: string;
  output?: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Partial<Args> = {};

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--input":  args.input  = argv[++i]; break;
      case "--table":  args.table  = argv[++i]; break;
      case "--output": args.output = argv[++i]; break;
    }
  }

  if (!args.input || !args.table) {
    console.error("Usage: convert-dcs --input <file> --table <tablename> [--output <file>]");
    process.exit(1);
  }

  return args as Args;
}

// ─── Core conversion ──────────────────────────────────────────────────────────

/**
 * Convert a single DC line from DCValidity format to transpiler format.
 *
 * Steps:
 *  1. Strip type annotations: ColumnName(Integer) → columnname
 *  2. Add table name after each tuple reference: t0.col → t0.tablename.col
 *
 * @param line      One line from a DCValidity soundDCs file.
 * @param tableName The name of the table to inject into the DC.
 * @returns         The converted DC string, or null if the line should be skipped.
 */
export function convertLine(line: string, tableName: string): string | null {
  const trimmed = line.trim();

  // Skip empty lines and comment lines
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  // Must start with the DC negation symbol
  if (!trimmed.startsWith("¬")) return null;

  // Step 1: rewrite each `tN.<col name>(<Type>)` token in one pass so that
  // (i) the type annotation is removed, (ii) the column name is sanitized to
  // match loader.ts#sanitizeIdentifier (lowercase, non-alphanumeric→underscore),
  // and (iii) the table prefix is injected. Capturing here is the only way to
  // keep multi-word column names (e.g. "Provider Number(String)") together —
  // a separate token-based regex stops at the first space.
  const converted = trimmed.replace(
    /\b(t\d+)\.([^()^]+?)\((?:Integer|String|Double|Float|Long|Boolean)\)/g,
    (_match, tupleId, rawCol) => {
      const safeCol = rawCol
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^[0-9]/, "_$&");
      return `${tupleId}.${tableName}.${safeCol}`;
    }
  );

  return converted;
}

/**
 * Convert an entire DCValidity soundDCs file to transpiler format.
 */
export function convertFile(inputPath: string, tableName: string): string {
  const content = fs.readFileSync(inputPath, "utf-8");
  const lines = content.split("\n");

  const header = [
    `# Denial Constraints for dataset: ${tableName}`,
    `# Source: DCValidity (https://github.com/nosocalgroc/DCValidity)`,
    `# Original file: ${path.basename(inputPath)}`,
    `# Format converted to: denial-constraints-transpiler`,
    `#`,
    `# Original format : ¬(t0.ColumnName(Type) op t1.ColumnName(Type) ^ ...)`,
    `# Converted format: ¬(t0.${tableName}.columnname op t1.${tableName}.columnname ^ ...)`,
    ``,
  ].join("\n");

  const converted = lines
    .map((line) => convertLine(line, tableName))
    .filter((line): line is string => line !== null);

  return header + converted.join("\n") + "\n";
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  const result = convertFile(args.input, args.table);

  if (args.output) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, result, "utf-8");
    console.log(`Converted ${args.input} → ${args.output}`);
  } else {
    process.stdout.write(result);
  }
}

main();
