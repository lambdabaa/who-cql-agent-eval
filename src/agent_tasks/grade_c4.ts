import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PredictionsFileSchema, type PredictionTaskSpec } from './schema.js';

/**
 * Grade a C4 (prediction) submission.
 *
 * Compare the agent's `outputs/predictions.json` against the captured
 * `groundtruth/predictions.json`. Score = correct predictions / total
 * predictions, where total = patients × defines. A missing prediction counts
 * as a miss for that cell, not for the whole patient.
 *
 * Comparison is strict for booleans/numbers/null and trimmed-string for
 * strings (newline / trailing-whitespace differences are ignored). The
 * Guidance text in WHO libraries contains literal newlines; agents that emit
 * the same string with a trailing newline shouldn't be penalised.
 */

export interface GradeC4Options {
  spec: PredictionTaskSpec;
  taskDir: string;
  /** Output path for the per-task grading report. */
  reportPath: string;
}

export interface GradeC4Result {
  taskId: string;
  agentSubmitted: boolean;
  totalCells: number;
  correctCells: number;
  /** Per-patient: { patientId, correct, total, misses: [{define, expected, actual}] }. */
  perPatient: Array<{
    patientId: string;
    correct: number;
    total: number;
    misses: Array<{ define: string; expected: unknown; actual: unknown; reason: string }>;
  }>;
  parseError?: string;
}

export function gradeC4(opts: GradeC4Options): GradeC4Result {
  const submission = join(opts.taskDir, 'outputs', 'predictions.json');
  const groundtruth = join(opts.taskDir, 'groundtruth', 'predictions.json');
  if (!existsSync(groundtruth)) throw new Error(`groundtruth missing at ${groundtruth}`);

  const truthRaw = JSON.parse(readFileSync(groundtruth, 'utf8'));
  const truth = PredictionsFileSchema.parse(truthRaw);

  if (!existsSync(submission)) {
    return {
      taskId: opts.spec.id,
      agentSubmitted: false,
      totalCells: opts.spec.patientIds.length * opts.spec.defines.length,
      correctCells: 0,
      perPatient: opts.spec.patientIds.map((pid) => ({
        patientId: pid,
        correct: 0,
        total: opts.spec.defines.length,
        misses: opts.spec.defines.map((d) => ({
          define: d,
          expected: truth[pid]?.[d] ?? null,
          actual: null,
          reason: 'no submission',
        })),
      })),
    };
  }

  let predRaw: unknown;
  try {
    predRaw = JSON.parse(readFileSync(submission, 'utf8'));
  } catch (e) {
    return {
      taskId: opts.spec.id,
      agentSubmitted: true,
      totalCells: opts.spec.patientIds.length * opts.spec.defines.length,
      correctCells: 0,
      perPatient: [],
      parseError: `predictions.json is not valid JSON: ${(e as Error).message}`,
    };
  }
  const parsed = PredictionsFileSchema.safeParse(predRaw);
  if (!parsed.success) {
    return {
      taskId: opts.spec.id,
      agentSubmitted: true,
      totalCells: opts.spec.patientIds.length * opts.spec.defines.length,
      correctCells: 0,
      perPatient: [],
      parseError: `predictions.json fails schema: ${parsed.error.message}`,
    };
  }
  const predictions = parsed.data;

  let correct = 0;
  let total = 0;
  const perPatient: GradeC4Result['perPatient'] = [];
  for (const pid of opts.spec.patientIds) {
    const truthRow = truth[pid] ?? {};
    const predRow = predictions[pid] ?? {};
    let pCorrect = 0;
    let pTotal = 0;
    const misses: GradeC4Result['perPatient'][number]['misses'] = [];
    for (const define of opts.spec.defines) {
      pTotal += 1;
      total += 1;
      const expected = truthRow[define] ?? null;
      const actual = define in predRow ? predRow[define] : undefined;
      const cmp = compareCell(expected, actual);
      if (cmp.pass) {
        pCorrect += 1;
        correct += 1;
      } else {
        misses.push({ define, expected, actual: actual ?? null, reason: cmp.reason });
      }
    }
    perPatient.push({ patientId: pid, correct: pCorrect, total: pTotal, misses });
  }

  const result: GradeC4Result = {
    taskId: opts.spec.id,
    agentSubmitted: true,
    totalCells: total,
    correctCells: correct,
    perPatient,
  };
  writeFileSync(opts.reportPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function compareCell(expected: unknown, actual: unknown): { pass: boolean; reason: string } {
  if (actual === undefined) return { pass: false, reason: 'missing prediction' };
  if (expected === null && actual === null) return { pass: true, reason: '' };
  if (typeof expected === 'string' && typeof actual === 'string') {
    if (normalizeString(expected) === normalizeString(actual)) return { pass: true, reason: '' };
    return { pass: false, reason: 'string mismatch' };
  }
  if (expected === actual) return { pass: true, reason: '' };
  return { pass: false, reason: 'value mismatch' };
}

function normalizeString(s: string): string {
  return s.replace(/\s+$/g, '').replace(/\r\n/g, '\n');
}
