import { Parser } from "node-sql-parser";
import { DCParser } from "../../parser";
import { JoinEliminationRewriter } from "../je-rewriter";

const dcParser = new DCParser();
const sqlParser = new Parser();
const PG_OPT = { database: "PostgresQL" } as const;

// Shared rewriter (no Pool; all tests use skipKeyCheck: true)
const rewriter = new JoinEliminationRewriter(dcParser);

// DC that encodes employees.gender_code → employees.gender_name
const GENDER_FD_DC =
  "¬(t0.employees.gender_code == t1.employees.gender_code ^ t0.employees.gender_name <> t1.employees.gender_name)";

// Helper: return number of FROM entries in the parsed optimized SQL
function fromCount(sql: string): number {
  const ast = sqlParser.astify(sql, PG_OPT) as unknown as Record<string, unknown>;
  return (ast["from"] as unknown[]).length;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("JoinEliminationRewriter", () => {
  it("eliminates a redundant INNER JOIN when FD holds and joined cols are unused", async () => {
    const sql =
      "SELECT e.id, e.name, e.salary FROM employees e INNER JOIN gender g ON e.gender_code = g.code WHERE e.salary > 50000";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(true);
    expect(result.eliminated).toHaveLength(1);
    expect(result.eliminated[0].joinAlias).toBe("g");
    // Optimized query should have only one FROM entry (the base table)
    expect(fromCount(result.optimizedSQL)).toBe(1);
    expect(result.optimizedSQL).not.toMatch(/\bINNER JOIN\b/i);
  });

  it("does not eliminate when a joined column appears in the SELECT list", async () => {
    const sql =
      "SELECT e.id, g.label FROM employees e INNER JOIN gender g ON e.gender_code = g.code WHERE e.salary > 50000";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(false);
    expect(result.eliminated).toHaveLength(0);
    expect(result.optimizedSQL).toBe(sql);
  });

  it("does not eliminate when a joined column appears in the WHERE clause", async () => {
    const sql =
      "SELECT e.id, e.name FROM employees e INNER JOIN gender g ON e.gender_code = g.code WHERE g.active = 1";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(false);
    expect(result.eliminated).toHaveLength(0);
  });

  it("does not eliminate when the query uses SELECT *", async () => {
    const sql =
      "SELECT * FROM employees e INNER JOIN gender g ON e.gender_code = g.code";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(false);
    expect(result.eliminated).toHaveLength(0);
  });

  it("does not eliminate when no DC is FD-shaped", async () => {
    const nonFdDC =
      "¬(t0.employees.salary < t1.employees.salary ^ t0.employees.role <> t1.employees.role)";
    const sql =
      "SELECT e.id, e.name FROM employees e INNER JOIN gender g ON e.gender_code = g.code WHERE e.salary > 50000";

    const result = await rewriter.rewrite(sql, [nonFdDC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(false);
    expect(result.eliminated).toHaveLength(0);
  });

  it("eliminates a redundant JOIN USING", async () => {
    // USING (gender_code): same column on both sides
    const sql =
      "SELECT e.id, e.name FROM employees e INNER JOIN gender g USING (gender_code)";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(true);
    expect(result.eliminated).toHaveLength(1);
    expect(fromCount(result.optimizedSQL)).toBe(1);
  });

  it("eliminates only the eligible JOIN when multiple JOINs are present", async () => {
    // gender JOIN is eligible; dept JOIN is not (d.dept_name is in SELECT)
    const sql =
      "SELECT e.id, e.name, d.dept_name FROM employees e " +
      "INNER JOIN gender g ON e.gender_code = g.code " +
      "INNER JOIN dept d ON e.dept_id = d.id " +
      "WHERE e.salary > 50000";

    const result = await rewriter.rewrite(sql, [GENDER_FD_DC], {
      skipKeyCheck: true,
    });

    expect(result.applicable).toBe(true);
    expect(result.eliminated).toHaveLength(1);
    expect(result.eliminated[0].joinAlias).toBe("g");
    // dept join must still be present
    expect(fromCount(result.optimizedSQL)).toBe(2);
    expect(result.optimizedSQL).toMatch(/\bdept\b/i);
  });

  it("throws when Pool is absent and skipKeyCheck is not set", async () => {
    const sql =
      "SELECT e.id, e.name FROM employees e INNER JOIN gender g ON e.gender_code = g.code";

    await expect(
      rewriter.rewrite(sql, [GENDER_FD_DC])
    ).rejects.toThrow(/Pool/);
  });
});
