import { DCParser } from "../../parser";
import { extractFD, extractFDs } from "../fd-detector";

const parser = new DCParser();

describe("extractFD", () => {
  it("extracts a single-determinant FD", () => {
    const dc = parser.parse(
      "¬(t0.employees.gender_code == t1.employees.gender_code ^ t0.employees.gender_name <> t1.employees.gender_name)"
    );
    const fd = extractFD(dc);
    expect(fd).not.toBeNull();
    expect(fd!.determinant).toEqual(["gender_code"]);
    expect(fd!.dependent).toBe("gender_name");
    expect(fd!.tableName).toBe("employees");
  });

  it("extracts a composite-determinant FD", () => {
    const dc = parser.parse(
      "¬(t0.tax.zip == t1.tax.zip ^ t0.tax.state == t1.tax.state ^ t0.tax.city <> t1.tax.city)"
    );
    const fd = extractFD(dc);
    expect(fd).not.toBeNull();
    expect(fd!.determinant).toEqual(["zip", "state"]);
    expect(fd!.dependent).toBe("city");
    expect(fd!.tableName).toBe("tax");
  });

  it("returns null when an order operator is present", () => {
    const dc = parser.parse(
      "¬(t0.t.salary < t1.t.salary ^ t0.t.role <> t1.t.role)"
    );
    expect(extractFD(dc)).toBeNull();
  });

  it("returns null for two inequality predicates", () => {
    const dc = parser.parse(
      "¬(t0.t.a <> t1.t.a ^ t0.t.b <> t1.t.b)"
    );
    expect(extractFD(dc)).toBeNull();
  });

  it("returns null when there is no equality predicate (no determinant)", () => {
    const dc = parser.parse("¬(t0.t.a <> t1.t.a)");
    expect(extractFD(dc)).toBeNull();
  });

  it("returns null for cross-column equality (left col ≠ right col)", () => {
    // t0.t.a == t1.t.b — the two tuple variables reference different columns
    const dc = parser.parse(
      "¬(t0.t.a == t1.t.b ^ t0.t.c <> t1.t.c)"
    );
    expect(extractFD(dc)).toBeNull();
  });
});

describe("extractFDs", () => {
  it("extracts only FD-shaped DCs from a mixed list", () => {
    const fdDC = parser.parse(
      "¬(t0.emp.zip == t1.emp.zip ^ t0.emp.city <> t1.emp.city)"
    );
    const nonFdDC = parser.parse(
      "¬(t0.emp.salary < t1.emp.salary ^ t0.emp.role <> t1.emp.role)"
    );
    const fds = extractFDs([fdDC, nonFdDC]);
    expect(fds).toHaveLength(1);
    expect(fds[0].dependent).toBe("city");
  });

  it("returns empty array for empty input", () => {
    expect(extractFDs([])).toEqual([]);
  });
});
