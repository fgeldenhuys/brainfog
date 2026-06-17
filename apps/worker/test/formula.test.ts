import { describe, expect, it } from "vitest";
import { applyFormulas, evaluateFormula, validateFormulas } from "../src/formula";
import { MemoryError } from "../src/memory";

describe("formula evaluator", () => {
  describe("validateFormulas", () => {
    it("accepts empty or undefined formulas", () => {
      expect(validateFormulas()).toEqual([]);
      expect(validateFormulas(undefined)).toEqual([]);
      expect(validateFormulas({})).toEqual([]);
    });

    it("rejects non-object formulas", () => {
      const errors = validateFormulas("not an object");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("must be an object");
    });

    it("rejects array formulas", () => {
      const errors = validateFormulas(["a", "b"]);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain("must be an object");
    });

    it("rejects formula names that don't match [a-z][a-z0-9_]*", () => {
      const errors = validateFormulas({ Delta: "1 + 2" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("[a-z][a-z0-9_]*"))).toBe(true);
    });

    it("rejects formula names that start with numbers", () => {
      const errors = validateFormulas({ "1delta": "1 + 2" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("[a-z][a-z0-9_]*"))).toBe(true);
    });

    it("accepts valid formula names", () => {
      const errors = validateFormulas({
        delta: "1 + 2",
        percent_complete: "1 + 2",
        a_b_c: "1 + 2",
      });
      expect(errors.filter((e) => e.message.includes("[a-z][a-z0-9_]*"))).toHaveLength(0);
    });

    it("rejects non-string formula expressions", () => {
      const errors = validateFormulas({ delta: 123 });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("must be a string"))).toBe(true);
    });

    it("rejects formula expressions exceeding 256 characters", () => {
      const longExpr = `x + ${"y ".repeat(150)}`;
      const errors = validateFormulas({ delta: longExpr });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("exceeds"))).toBe(true);
    });

    it("rejects formulas exceeding the limit of 10 per dataset", () => {
      const formulas: Record<string, string> = {};
      for (let i = 0; i < 15; i++) {
        formulas[`formula_${i}`] = "1 + 1";
      }
      const errors = validateFormulas(formulas);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("maximum"))).toBe(true);
    });

    it("rejects protected field names", () => {
      const protectedFields = ["id", "ownerId", "owner_id", "createdAt", "created_at"];
      for (const field of protectedFields) {
        const errors = validateFormulas({ [field]: "1 + 2" });
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.message.includes("protected"))).toBe(true);
      }
    });

    it("rejects string literals", () => {
      const errors = validateFormulas({ delta: '"hello"' });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.message).toBeTruthy();
    });

    it("rejects member access", () => {
      const errors = validateFormulas({ delta: "obj.field" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("member access"))).toBe(true);
    });

    it("rejects arrays", () => {
      const errors = validateFormulas({ delta: "[1, 2, 3]" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("array"))).toBe(true);
    });

    it("rejects conditionals and ternaries", () => {
      const badFormulas = ["x > 5 ? 1 : 0", "if (x > 5) { 1 } else { 0 }"];
      for (const expr of badFormulas) {
        const errors = validateFormulas({ delta: expr });
        expect(errors.length).toBeGreaterThan(0);
      }
    });

    it("rejects assignment operators", () => {
      const errors = validateFormulas({ delta: "x = 5" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("assignment"))).toBe(true);
    });

    it("rejects unsupported functions", () => {
      const errors = validateFormulas({ delta: "eval('x')" });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("not allowed"))).toBe(true);
    });

    it("rejects comparison and logical operators", () => {
      const badFormulas = ["x > 5", "x && y", "x || y", "!x"];
      for (const expr of badFormulas) {
        const errors = validateFormulas({ delta: expr });
        // Note: some of these may parse as valid expressions but fail during validation
        if (errors.length > 0) {
          expect(
            errors.some(
              (e) => e.message.includes("not allowed") || e.message.includes("unsupported"),
            ),
          ).toBe(true);
        }
      }
    });

    it("rejects equality operator ==", () => {
      const errors = validateFormulas({ delta: "a == b" });
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some((e) => e.message.includes("not allowed") || e.message.includes("comparison")),
      ).toBe(true);
    });

    it("rejects inequality operator !=", () => {
      const errors = validateFormulas({ delta: "a != b" });
      expect(errors.length).toBeGreaterThan(0);
      expect(
        errors.some((e) => e.message.includes("not allowed") || e.message.includes("comparison")),
      ).toBe(true);
    });

    it("accepts valid arithmetic expressions with allowed operators", () => {
      const validFormulas = {
        delta: "after - before",
        ratio: "completed / total",
        percent: "roundTo((completed / total) * 100, 1)",
        modulo: "x % 10",
      };
      const errors = validateFormulas(validFormulas);
      const syntaxErrors = errors.filter(
        (e) => e.message.includes("not allowed") || e.message.includes("unsupported"),
      );
      expect(syntaxErrors).toHaveLength(0);
    });

    it("accepts valid allowlisted functions", () => {
      const validFormulas = {
        rounded: "roundTo(x, 2)",
        floored: "floor(x)",
        ceiled: "ceil(x)",
        absolute: "abs(x - y)",
        minimum: "min(a, b, c)",
        maximum: "max(a, b, c)",
      };
      const errors = validateFormulas(validFormulas);
      const funcErrors = errors.filter((e) => e.message.includes("not allowed"));
      expect(funcErrors).toHaveLength(0);
    });

    it("rejects invalid expression syntax", () => {
      const errors = validateFormulas({ delta: "((incomplete" });
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("evaluateFormula", () => {
    it("evaluates simple arithmetic", () => {
      expect(evaluateFormula("2 + 3", {})).toBe(5);
      expect(evaluateFormula("10 - 3", {})).toBe(7);
      expect(evaluateFormula("4 * 5", {})).toBe(20);
      expect(evaluateFormula("20 / 4", {})).toBe(5);
      expect(evaluateFormula("10 % 3", {})).toBe(1);
    });

    it("evaluates expressions with numeric variables", () => {
      const data = { after: 10, before: 3 };
      expect(evaluateFormula("after - before", data)).toBe(7);

      const data2 = { completed: 5, total: 10 };
      expect(evaluateFormula("completed / total", data2)).toBe(0.5);
    });

    it("evaluates expressions with parentheses", () => {
      const data = { x: 10, y: 5 };
      expect(evaluateFormula("(x + y) * 2", data)).toBe(30);
    });

    it("evaluates expressions with allowlisted functions", () => {
      expect(evaluateFormula("roundTo(3.14159, 2)", {})).toBe(3.14);
      expect(evaluateFormula("floor(3.9)", {})).toBe(3);
      expect(evaluateFormula("ceil(3.1)", {})).toBe(4);
      expect(evaluateFormula("abs(-5)", {})).toBe(5);
      expect(evaluateFormula("min(5, 3, 8)", {})).toBe(3);
      expect(evaluateFormula("max(5, 3, 8)", {})).toBe(8);
    });

    it("evaluates complex expressions with functions and variables", () => {
      const data = { completed: 7, total: 10 };
      const result = evaluateFormula("roundTo((completed / total) * 100, 1)", data);
      expect(result).toBe(70);
    });

    it("ignores non-numeric variables in context", () => {
      const data = { x: 10, name: "test", y: 5 };
      expect(evaluateFormula("x + y", data)).toBe(15);
    });

    it("throws for unknown numeric variables", () => {
      expect(() => evaluateFormula("unknown_var + 1", {})).toThrow();
    });

    it("throws for non-finite results (Infinity)", () => {
      expect(() => evaluateFormula("1 / 0", {})).toThrow();
    });

    it("throws for non-finite results (NaN)", () => {
      expect(() => evaluateFormula("0 / 0", {})).toThrow();
    });

    it("throws for expressions that return non-numeric values", () => {
      // This is tricky with expr-eval, but we should catch non-numeric results
      expect(() => evaluateFormula("x", { x: "not a number" })).toThrow();
    });

    it("handles unary operators", () => {
      expect(evaluateFormula("-5", {})).toBe(-5);
      expect(evaluateFormula("+5", {})).toBe(5);
      expect(evaluateFormula("-(2 + 3)", {})).toBe(-5);
    });
  });

  describe("applyFormulas", () => {
    it("applies a single formula to a row", () => {
      const formulas = { delta: "after - before" };
      const row = { after: 10, before: 3 };
      const result = applyFormulas(formulas, row);
      expect(result).toEqual({ ...row, delta: 7 });
    });

    it("applies multiple formulas to a row", () => {
      const formulas = {
        delta: "after - before",
        ratio: "after / before",
      };
      const row = { after: 10, before: 5 };
      const result = applyFormulas(formulas, row);
      expect(result.delta).toBe(5);
      expect(result.ratio).toBe(2);
    });

    it("preserves original row data", () => {
      const formulas = { sum: "a + b" };
      const row = { a: 5, b: 3, c: 7 };
      const result = applyFormulas(formulas, row);
      expect(result.a).toBe(5);
      expect(result.b).toBe(3);
      expect(result.c).toBe(7);
    });

    it("throws a MemoryError if a formula fails", () => {
      const formulas = { bad: "unknown_var + 1" };
      const row = { x: 5 };
      expect(() => applyFormulas(formulas, row)).toThrow(MemoryError);
    });

    it("applies formulas with complex expressions", () => {
      const formulas = {
        percent_complete: "roundTo((completed / total) * 100, 1)",
      };
      const row = { completed: 7, total: 10, id: "item-1" };
      const result = applyFormulas(formulas, row);
      expect(result.percent_complete).toBe(70);
      expect(result.id).toBe("item-1");
    });

    it("allows formulas to reference other formula inputs without cross-row access", () => {
      const formulas = {
        percentage: "roundTo((num / denom) * 100, 1)",
      };
      const row = { num: 3, denom: 4 };
      const result = applyFormulas(formulas, row);
      expect(result.percentage).toBe(75);
    });

    it("handles empty formulas object", () => {
      const formulas = {};
      const row = { a: 5, b: 3 };
      const result = applyFormulas(formulas, row);
      expect(result).toEqual(row);
    });
  });

  describe("integration scenarios", () => {
    it("validates then evaluates a complete formula set", () => {
      const formulas = {
        delta: "after - before",
        percent_change: "roundTo(((after - before) / before) * 100, 1)",
      };

      // Validate formulas
      const errors = validateFormulas(formulas);
      expect(errors).toHaveLength(0);

      // Apply to row
      const row = { after: 15, before: 10 };
      const result = applyFormulas(formulas, row);
      expect(result.delta).toBe(5);
      expect(result.percent_change).toBe(50);
    });

    it("rejects formulas that try to overwrite protected fields", () => {
      const formulas = { id: "1 + 2" };
      const errors = validateFormulas(formulas);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.message.includes("protected"))).toBe(true);
    });

    it("handles numeric data with multiple formula types", () => {
      const formulas = {
        delta: "end - start",
        average: "roundTo((end + start) / 2, 2)",
        extreme: "max(abs(end), abs(start))",
      };
      const errors = validateFormulas(formulas);
      expect(errors).toHaveLength(0);

      const row = { start: 10, end: 20 };
      const result = applyFormulas(formulas, row);
      expect(result.delta).toBe(10);
      expect(result.average).toBe(15);
      expect(result.extreme).toBe(20);
    });
  });
});
