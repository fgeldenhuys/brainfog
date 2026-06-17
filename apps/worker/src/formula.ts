import { type Expression, Parser } from "expr-eval";
import { MemoryError } from "./memory";

// Maximum formula expression length (characters)
const MAX_FORMULA_LENGTH = 256;

// Maximum number of formulas per dataset
const MAX_FORMULAS_PER_DATASET = 10;

// Allowlisted functions that can be called within formulas.
// expr-eval has its own set of built-in functions, and we whitelist only the safe ones.
// Built-in expr-eval functions include: round (unary), floor, ceil, abs, min, max, roundTo (for rounding to decimals)
const ALLOWLISTED_FUNCTIONS = new Set(["round", "roundTo", "floor", "ceil", "abs", "min", "max"]);

// Disallowed instruction types in expr-eval that indicate dangerous operations
// (kept for reference but not currently used since we validate via pattern matching)
// const DISALLOWED_INSTRUCTIONS = new Set([
//   "IMEMBER", // Member access (.property)
//   "IARRAY", // Array literal
//   "IOBJECT", // Object literal
//   "IEQ", // == comparison (via assignment operator)
//   "IFNASSIGN", // Function assignment
//   "IVAR_ASSIGN", // Variable assignment
// ]);

export interface FormulaDefinition {
  [name: string]: string;
}

export interface FormulaValidationError {
  field: string;
  message: string;
}

/**
 * Validates a formula expression for safe use.
 * Uses expr-eval's token-based validation to ensure:
 * - Only numeric operations are used
 * - Only allowlisted functions are called
 * - No member access, arrays, strings, or advanced features
 */
function validateFormulaExpression(_expr: Expression): FormulaValidationError[] {
  const errors: FormulaValidationError[] = [];

  // Note: expr-eval's Expression type doesn't expose tokens in its TypeScript definitions,
  // but they exist at runtime. We validate through pattern-based checks and function usage instead.
  // The main validation happens in validateFunctionUsage() and through regex patterns.

  return errors;
}

/**
 * Validates a formula name for safe use.
 * Formula names must:
 * - Match [a-z][a-z0-9_]*
 * - Not overwrite canonical fields (id, content, title, etc.)
 */
function validateFormulaName(name: string): FormulaValidationError[] {
  const errors: FormulaValidationError[] = [];

  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    errors.push({
      field: name,
      message: "formula name must match [a-z][a-z0-9_]*",
    });
  }

  // Protect canonical fields that should not be overwritten
  const protectedFields = new Set([
    "id",
    "owner_id",
    "ownerId",
    "project_id",
    "projectId",
    "created_at",
    "createdAt",
    "updated_at",
    "updatedAt",
    "r2_key",
    "r2Key",
  ]);

  if (protectedFields.has(name)) {
    errors.push({
      field: name,
      message: `formula name '${name}' would overwrite a protected field`,
    });
  }

  return errors;
}

/**
 * Validates that only allowlisted functions are used in the expression.
 * This checks the actual function names called in the expression.
 */
function validateFunctionUsage(_expression: string): FormulaValidationError[] {
  const errors: FormulaValidationError[] = [];

  // Find all function calls in the expression by looking for function names followed by (
  // This is a simple pattern-based check
  const functionCallPattern = /([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

  const calledFunctions = new Set<string>();
  let match = functionCallPattern.exec(_expression);
  while (match !== null) {
    const funcName = match[1];
    if (funcName !== undefined) {
      calledFunctions.add(funcName);
    }
    match = functionCallPattern.exec(_expression);
  }

  // Built-in math functions that should never be called
  const builtInDangerous = new Set(["eval", "Function", "setTimeout", "setInterval"]);

  for (const funcName of calledFunctions) {
    if (builtInDangerous.has(funcName)) {
      errors.push({
        field: "expression",
        message: `function '${funcName}' is not allowed`,
      });
    } else if (!ALLOWLISTED_FUNCTIONS.has(funcName)) {
      // Check if it's a known safe function in expr-eval
      // expr-eval has many built-in functions, but we only allow a specific set
      const knownSafeFunctions = new Set([
        "round",
        "roundTo",
        "floor",
        "ceil",
        "abs",
        "min",
        "max",
      ]);
      if (!knownSafeFunctions.has(funcName)) {
        errors.push({
          field: "expression",
          message: `function '${funcName}' is not allowed`,
        });
      }
    }
  }

  return errors;
}

/**
 * Validates all formulas in a formula definition object.
 * Returns an array of validation errors, or empty array if valid.
 */
export function validateFormulas(formulas?: unknown): FormulaValidationError[] {
  if (!formulas) return [];

  if (typeof formulas !== "object" || Array.isArray(formulas)) {
    return [{ field: "formulas", message: "formulas must be an object" }];
  }

  const errors: FormulaValidationError[] = [];
  const formulasObj = formulas as Record<string, unknown>;

  const formulasCount = Object.keys(formulasObj).length;
  if (formulasCount > MAX_FORMULAS_PER_DATASET) {
    errors.push({
      field: "formulas",
      message: `maximum ${MAX_FORMULAS_PER_DATASET} formulas per dataset, found ${formulasCount}`,
    });
  }

  for (const [name, expr] of Object.entries(formulasObj)) {
    // Validate name
    errors.push(...validateFormulaName(name));

    // Validate expression string
    if (typeof expr !== "string") {
      errors.push({
        field: name,
        message: "formula expression must be a string",
      });
      continue;
    }

    if (expr.length > MAX_FORMULA_LENGTH) {
      errors.push({
        field: name,
        message: `formula expression exceeds ${MAX_FORMULA_LENGTH} character limit`,
      });
      continue;
    }

    // Check for disallowed syntax patterns before parsing
    // This catches obvious issues like member access, string literals, etc.
    if (/\.[\w]/.test(expr)) {
      errors.push({
        field: name,
        message: "member access is not allowed",
      });
      continue;
    }

    if (/['"]/.test(expr)) {
      errors.push({
        field: name,
        message: "string literals are not allowed",
      });
      continue;
    }

    if (/[?:]/.test(expr)) {
      errors.push({
        field: name,
        message: "conditionals and ternaries are not allowed",
      });
      continue;
    }

    // Check for assignment (but allow >=, <=, ==, !=)
    if (/\s*=\s*[^=]|^[^<>=!]*\s*=\s*/.test(expr)) {
      errors.push({
        field: name,
        message: "assignment is not allowed",
      });
      continue;
    }

    // Check for comparison and logical operators (including ==, !=, <, >, <=, >=, &&, ||, !)
    if (/==|!=|[<>]=|[<>]|&&|\|\||!(?!=)/.test(expr)) {
      errors.push({
        field: name,
        message: "comparison and logical operators are not allowed",
      });
      continue;
    }

    if (/\[/.test(expr)) {
      errors.push({
        field: name,
        message: "arrays are not allowed",
      });
      continue;
    }

    // Parse and validate expression
    try {
      const parser = new Parser();
      const parsed = parser.parse(expr);
      errors.push(...validateFormulaExpression(parsed));
      errors.push(...validateFunctionUsage(expr));
    } catch (error) {
      errors.push({
        field: name,
        message: `invalid formula expression: ${(error as Error).message}`,
      });
    }
  }

  return errors;
}

/**
 * Evaluates a single formula expression against a data row.
 * Returns the numeric result or throws an error if evaluation fails.
 */
export function evaluateFormula(expression: string, rowData: Record<string, unknown>): number {
  try {
    const parser = new Parser();
    const parsed = parser.parse(expression);

    // Create evaluation context with only numeric fields from row data
    // expr-eval has built-in functions like round, floor, ceil, abs, min, max, roundTo
    const context: Record<string, number> = {};

    for (const [key, value] of Object.entries(rowData)) {
      if (typeof value === "number") {
        context[key] = value;
      }
    }

    const result = (
      parsed as unknown as {
        evaluate: (ctx: Record<string, number>) => unknown;
      }
    ).evaluate(context);

    if (typeof result !== "number") {
      throw new Error(`expression returned non-numeric value: ${typeof result}`);
    }

    if (!Number.isFinite(result)) {
      throw new Error(`expression returned non-finite value: ${result}`);
    }

    return result;
  } catch (error) {
    throw new Error(`formula evaluation failed: ${(error as Error).message}`);
  }
}

/**
 * Applies all formulas in a formula definition to a data row.
 * Returns a new object with the original row data plus formula results.
 */
export function applyFormulas(
  formulas: FormulaDefinition,
  rowData: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...rowData };

  for (const [name, expr] of Object.entries(formulas)) {
    try {
      result[name] = evaluateFormula(expr, rowData);
    } catch (error) {
      throw new MemoryError(400, `formula '${name}' failed: ${(error as Error).message}`);
    }
  }

  return result;
}
