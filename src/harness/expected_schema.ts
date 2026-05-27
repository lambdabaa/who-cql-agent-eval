import { z } from 'zod';

/**
 * Schema for the `expected:` YAML block — the v0 contribution back to WHO.
 *
 * WHO's existing `examples.yaml` files express expected outputs in free-text
 * `### ...` comments. This block makes them machine-checkable: per patient
 * (one YAML document) and per CQL define, record the expected return value
 * and (optionally) the named test row from the L2 decision table.
 *
 * Example YAML overlay:
 *
 *   id: Measles23.3
 *   birth: -12m
 *   expected:
 *     row: Measles.LowTransmission.R2  # optional human-readable cross-ref
 *     today: 2026-01-15                # optional override; defaults to harness-wide today
 *     defines:
 *       "Client is due for MCV1": true
 *       "Client is not due for MCV1": false
 *       "Guidance":
 *         equals: "Should vaccinate client with MCV1 as no measles..."
 */

/**
 * A single expected value for one CQL define.
 *
 * Shorthand:
 *   - `true` / `false` / number / null → exact equality
 *   - string → exact equality (use `equals` for strings containing whitespace/newlines)
 *
 * Long form ({equals|matches|isNull|isNotNull}) is required when the value
 * needs special comparison or when the shorthand would be ambiguous.
 */
const ExpectedScalar = z.union([z.boolean(), z.number(), z.string(), z.null()]);

const ExpectedLongForm = z
  .object({
    equals: z.unknown().optional(),
    matches: z.string().optional(),
    isNull: z.boolean().optional(),
    isNotNull: z.boolean().optional(),
    note: z.string().optional(),
  })
  .strict()
  .refine(
    (v) =>
      [v.equals !== undefined, v.matches !== undefined, v.isNull !== undefined, v.isNotNull !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: 'expected: must specify exactly one of equals | matches | isNull | isNotNull' },
  );

export const ExpectedValueSchema = z.union([ExpectedScalar, ExpectedLongForm]);
export type ExpectedValue = z.infer<typeof ExpectedValueSchema>;

export const ExpectedBlockSchema = z
  .object({
    row: z.string().optional(),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'today must be YYYY-MM-DD')
      .optional(),
    encounterId: z.string().optional(),
    defines: z.record(z.string(), ExpectedValueSchema),
  })
  .strict();

export type ExpectedBlock = z.infer<typeof ExpectedBlockSchema>;

export interface ComparisonResult {
  define: string;
  pass: boolean;
  expected: ExpectedValue;
  actual: unknown;
  reason?: string;
}

/**
 * Compare an actual CQL define result against an ExpectedValue.
 *
 * cql-execution returns JS primitives for scalar defines; lists/intervals/dates
 * are wrapped objects. v0 only asserts on scalar defines — the `equals` form
 * normalizes both sides to strict JSON-equality so date/interval coverage can
 * be added in a follow-up without changing this surface.
 */
export function compareExpected(define: string, actual: unknown, expected: ExpectedValue): ComparisonResult {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const e = expected as Exclude<ExpectedValue, null | boolean | number | string>;
    if (e.isNull === true) {
      return { define, pass: actual === null || actual === undefined, expected, actual };
    }
    if (e.isNotNull === true) {
      return { define, pass: actual !== null && actual !== undefined, expected, actual };
    }
    if (e.matches !== undefined) {
      const re = new RegExp(e.matches);
      return {
        define,
        pass: typeof actual === 'string' && re.test(actual),
        expected,
        actual,
        ...(typeof actual === 'string' ? {} : { reason: 'actual is not a string' }),
      };
    }
    if (e.equals !== undefined) {
      return jsonEqualResult(define, actual, e.equals, expected);
    }
    return { define, pass: false, expected, actual, reason: 'malformed expected block' };
  }

  return jsonEqualResult(define, actual, expected, expected);
}

function jsonEqualResult(
  define: string,
  actual: unknown,
  expected: unknown,
  expectedRaw: ExpectedValue,
): ComparisonResult {
  return {
    define,
    pass: jsonEqual(actual, expected),
    expected: expectedRaw,
    actual,
  };
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => jsonEqual(v, b[i]));
  }
  const ak = Object.keys(a as object).sort();
  const bk = Object.keys(b as object).sort();
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}
