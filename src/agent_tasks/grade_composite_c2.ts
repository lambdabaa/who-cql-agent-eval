import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompositeDetectionsFileSchema,
  type CompositeDetectionTaskSpec,
  type MutationKind,
} from './schema.js';

/**
 * Set-based grader for composite_detection tasks.
 *
 * Match policy: a finding matches a truth bug iff its `define` is in the
 * truth bug's `definesAffected` (or equals `define` for back-compat).
 * `mutationKind` is reported as a secondary axis but doesn't drive
 * matching — we don't want to penalise agents for mislabelling the bug
 * class when they correctly identified *where* it is.
 *
 * Global F1 is computed over all (variant, finding) pairs:
 *   precision = TP / (TP + FP)
 *   recall    = TP / (TP + FN)
 *   F1        = 2PR / (P + R)
 *
 * Per-variant breakdown is also surfaced so we can see whether agents
 * partially-detect (find some of N bugs) or all-or-nothing (find all or
 * none).
 */

interface TruthMutation {
  kind: MutationKind;
  define?: string;
  definesAffected?: string[];
  approxLine?: number;
}

interface TruthRecord {
  mutations: TruthMutation[];
}

export interface GradeCompositeC2Options {
  spec: CompositeDetectionTaskSpec;
  taskDir: string;
  reportPath: string;
}

export interface GradeCompositeC2Result {
  taskId: string;
  agentSubmitted: boolean;
  global: {
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    precision: number;
    recall: number;
    f1: number;
  };
  perVariant: Array<{
    variantId: string;
    truthBugCount: number;
    agentFindingCount: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    misses: Array<{ define: string; kind: MutationKind }>; // truth bugs the agent missed
    spurious: Array<{ define: string; kind?: MutationKind }>; // findings not in truth
  }>;
  /** Per-mutation-kind recall — for diagnostics. */
  perKindRecall: Record<string, { total: number; flagged: number }>;
  parseError?: string;
}

export function gradeCompositeC2(opts: GradeCompositeC2Options): GradeCompositeC2Result {
  const truthPath = join(opts.taskDir, 'groundtruth', 'truth.json');
  if (!existsSync(truthPath)) throw new Error(`truth missing at ${truthPath}`);
  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, TruthRecord>;

  const submission = join(opts.taskDir, 'outputs', 'detections.json');
  if (!existsSync(submission)) return emptyResult(opts.spec, truth, 'no submission');

  let predRaw: unknown;
  try {
    predRaw = JSON.parse(readFileSync(submission, 'utf8'));
  } catch (e) {
    return emptyResult(opts.spec, truth, `detections.json not valid JSON: ${(e as Error).message}`);
  }
  const parsed = CompositeDetectionsFileSchema.safeParse(predRaw);
  if (!parsed.success) {
    return emptyResult(opts.spec, truth, `detections.json fails schema: ${parsed.error.message}`);
  }
  const detections = parsed.data;

  let tp = 0;
  let fp = 0;
  let fn = 0;
  const perVariant: GradeCompositeC2Result['perVariant'] = [];
  const perKindRecall: Record<string, { total: number; flagged: number }> = {};

  for (const variantId of opts.spec.variantIds) {
    const t = truth[variantId];
    if (!t) continue;
    const truthBugs = t.mutations;
    const detection = detections[variantId];
    const findings = detection?.findings ?? [];

    // Match each truth bug at most once; greedy match by define name.
    const matchedTruth = new Set<number>();
    const matchedFinding = new Set<number>();
    for (let i = 0; i < findings.length; i += 1) {
      const f = findings[i]!;
      for (let j = 0; j < truthBugs.length; j += 1) {
        if (matchedTruth.has(j)) continue;
        const bug = truthBugs[j]!;
        const acceptable = bug.definesAffected && bug.definesAffected.length > 0
          ? bug.definesAffected
          : bug.define
          ? [bug.define]
          : [];
        if (acceptable.includes(f.define)) {
          matchedTruth.add(j);
          matchedFinding.add(i);
          break;
        }
      }
    }

    const vTp = matchedTruth.size;
    const vFp = findings.length - matchedFinding.size;
    const vFn = truthBugs.length - matchedTruth.size;
    tp += vTp;
    fp += vFp;
    fn += vFn;

    for (let j = 0; j < truthBugs.length; j += 1) {
      const bug = truthBugs[j]!;
      const k = bug.kind;
      if (!perKindRecall[k]) perKindRecall[k] = { total: 0, flagged: 0 };
      perKindRecall[k].total += 1;
      if (matchedTruth.has(j)) perKindRecall[k].flagged += 1;
    }

    const misses: GradeCompositeC2Result['perVariant'][number]['misses'] = [];
    for (let j = 0; j < truthBugs.length; j += 1) {
      if (!matchedTruth.has(j)) {
        const bug = truthBugs[j]!;
        misses.push({ define: bug.define ?? 'unknown', kind: bug.kind });
      }
    }
    const spurious: GradeCompositeC2Result['perVariant'][number]['spurious'] = [];
    for (let i = 0; i < findings.length; i += 1) {
      if (!matchedFinding.has(i)) {
        const f = findings[i]!;
        spurious.push({ define: f.define, ...(f.mutationKind ? { kind: f.mutationKind } : {}) });
      }
    }

    perVariant.push({
      variantId,
      truthBugCount: truthBugs.length,
      agentFindingCount: findings.length,
      truePositive: vTp,
      falsePositive: vFp,
      falseNegative: vFn,
      misses,
      spurious,
    });
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const result: GradeCompositeC2Result = {
    taskId: opts.spec.id,
    agentSubmitted: true,
    global: {
      truePositive: tp,
      falsePositive: fp,
      falseNegative: fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
    },
    perVariant,
    perKindRecall,
  };
  writeFileSync(opts.reportPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function emptyResult(spec: CompositeDetectionTaskSpec, truth: Record<string, TruthRecord>, reason: string): GradeCompositeC2Result {
  let fn = 0;
  const perVariant: GradeCompositeC2Result['perVariant'] = [];
  for (const variantId of spec.variantIds) {
    const t = truth[variantId];
    if (!t) continue;
    const bugCount = t.mutations.length;
    fn += bugCount;
    perVariant.push({
      variantId,
      truthBugCount: bugCount,
      agentFindingCount: 0,
      truePositive: 0,
      falsePositive: 0,
      falseNegative: bugCount,
      misses: t.mutations.map((m) => ({ define: m.define ?? 'unknown', kind: m.kind })),
      spurious: [],
    });
  }
  return {
    taskId: spec.id,
    agentSubmitted: false,
    global: { truePositive: 0, falsePositive: 0, falseNegative: fn, precision: 1, recall: 0, f1: 0 },
    perVariant,
    perKindRecall: {},
    parseError: reason,
  };
}
