import { Executor, Library, PatientContext, Repository, Results } from 'cql-execution';
import { PatientSource } from 'cql-exec-fhir';
import type { CompiledLibrary } from './compile_cql.js';
import type { FhirBundle } from './yaml_to_bundle.js';
import type { ExpectedBlock } from './expected_schema.js';
import { compareExpected, type ComparisonResult } from './expected_schema.js';

/**
 * Tier-3 (execute) grader. Runs a compiled Logic CQL library over one patient
 * Bundle and diffs the resulting per-define values against an `expected:`
 * block.
 *
 * Today / EncounterId
 * -------------------
 * The WHO Logic libraries declare `parameter Today Date default Today()` and
 * `parameter EncounterId String`. The harness *always* overrides `Today` with
 * a deterministic value (caller's `today` arg, or per-case override from the
 * `expected:` block) — otherwise runs against today's wall clock and any test
 * using `+Nd` / `-Nd` un-anchored shifts re-anchors to "now", which makes
 * runs non-reproducible.
 *
 * `EncounterId` is passed through as-is. WHO's `makeExample.js` emits no
 * Encounter resource for the immunizations DAK, so the libraries fall back to
 * Patient-context evaluation — passing `undefined` is the default.
 */

export interface RunCaseOptions {
  /** All compiled libraries (subject + dependencies). */
  libraries: CompiledLibrary[];
  /** Logic library identifier to evaluate (e.g. `IMMZD2DTMeaslesLowTransmissionLogic`). */
  logicLibraryId: string;
  /** Per-patient FHIR Bundle. */
  bundle: FhirBundle;
  /** Patient id this case is about. */
  patientId: string;
  /** Wall-clock anchor — forwarded to the CQL `Today` parameter unless the case overrides. */
  today: string; // YYYY-MM-DD
  /** Optional expected block to compare against. */
  expected?: ExpectedBlock;
  /**
   * Subset of defines to evaluate. If unset, every define listed in
   * `expected.defines` is evaluated. If both are unset, all defines in the
   * Logic library are evaluated.
   */
  defines?: string[];
}

export interface RunCaseResult {
  patientId: string;
  logicLibraryId: string;
  today: string;
  encounterId?: string;
  /** Raw `define` → value map from cql-execution. */
  results: Record<string, unknown>;
  /** Per-define comparison vs expected. Empty if no expected block. */
  comparisons: ComparisonResult[];
  /** True iff comparisons is non-empty and every comparison passed. */
  passed: boolean;
  /** Translator/runtime errors surfaced from the execution path. */
  errors: string[];
}

/**
 * Run one patient through one Logic library.
 *
 * Wraps cql-execution's Library/Repository/Executor wiring. Side-effect free —
 * each call builds a fresh PatientSource so cases are independently
 * reproducible.
 */
export function runCase(options: RunCaseOptions): RunCaseResult {
  const today = options.expected?.today ?? options.today;
  const encounterId = options.expected?.encounterId;
  const errors: string[] = [];

  const repoMap: Record<string, unknown> = {};
  let subject: unknown;
  for (const lib of options.libraries) {
    const id = (lib.elm as ElmShape)?.library?.identifier?.id;
    if (!id) continue;
    repoMap[id] = lib.elm;
    if (id === options.logicLibraryId) subject = lib.elm;
  }
  if (!subject) {
    return {
      patientId: options.patientId,
      logicLibraryId: options.logicLibraryId,
      today,
      ...(encounterId ? { encounterId } : {}),
      results: {},
      comparisons: [],
      passed: false,
      errors: [`logic library ${options.logicLibraryId} not present in compiled libraries`],
    };
  }

  const library = new Library(subject, new Repository(repoMap));
  const executor = new Executor(library, undefined, {
    Today: parseCqlDate(today),
    EncounterId: encounterId ?? null,
  });

  const patientSource = PatientSource.FHIRv401();
  patientSource.loadBundles([options.bundle]);

  let raw: Results | undefined;
  try {
    const result = executor.exec(patientSource);
    // cql-execution typings declare exec() returns Promise<Results>, but the
    // current JS implementation returns sync Results when given a non-async
    // PatientSource. Handle both.
    raw = (result instanceof Promise ? undefined : (result as Results));
    if (result instanceof Promise) {
      // Caller is in a sync code path; fall back to errors[] rather than
      // breaking the surface. The eval CLI awaits the wrapping call.
      errors.push('executor.exec returned a Promise; async path not yet wired');
    }
  } catch (e) {
    errors.push((e as Error).message);
  }

  const perPatient = (raw?.patientResults ?? {}) as Record<string, Record<string, unknown>>;
  const results = perPatient[options.patientId] ?? Object.values(perPatient)[0] ?? {};

  // Filter out internal helpers cql-execution injects (e.g. `Patient`).
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(results)) {
    if (k === 'Patient') continue;
    filtered[k] = v;
  }

  const comparisons: ComparisonResult[] = [];
  if (options.expected) {
    const targets = options.defines ?? Object.keys(options.expected.defines);
    for (const define of targets) {
      const expectedValue = options.expected.defines[define];
      if (expectedValue === undefined) continue;
      comparisons.push(compareExpected(define, filtered[define], expectedValue));
    }
  }

  const passed = comparisons.length > 0 && comparisons.every((c) => c.pass) && errors.length === 0;

  return {
    patientId: options.patientId,
    logicLibraryId: options.logicLibraryId,
    today,
    ...(encounterId ? { encounterId } : {}),
    results: filtered,
    comparisons,
    passed,
    errors,
  };
}

interface ElmShape {
  library?: { identifier?: { id?: string } };
}

/**
 * Build a cql-execution `Date` from `YYYY-MM-DD`. The constructor accepts
 * (year, month, day) — note month is 1-based here (unlike JS Date).
 */
function parseCqlDate(yyyyMmDd: string): unknown {
  // late-bind via runtime require to avoid top-level type drama
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DateTime } = require('cql-execution');
  const [y, m, d] = yyyyMmDd.split('-').map((n) => parseInt(n, 10));
  return DateTime.fromJSDate(new Date(Date.UTC(y!, (m ?? 1) - 1, d ?? 1)));
}

// avoid unused-import warning until PatientContext is wired in for
// encounter-context libraries (Phase 1).
void PatientContext;
