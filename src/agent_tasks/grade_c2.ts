import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DetectionsFileSchema,
  type DetectionRecord,
  type DetectionTaskSpec,
  type MutationKind,
} from './schema.js';

/**
 * Grade a C2 (cross-layer inconsistency detection) submission.
 *
 * Three axes, reported separately:
 *   - Detection: binary `hasBug` precision/recall/F1. Primary metric.
 *   - Localization: when truth.hasBug && agent.hasBug, did `define` match?
 *     (approximateLine is informational — agents reading mutated CQL can
 *     reasonably miss the exact line; we only score the define identifier.)
 *   - Classification: when both flagged, did `mutationKind` match?
 *
 * Missing variant entries in the agent's submission count as
 * `{ hasBug: false }` — a confident negative. That matches what the prompt
 * tells the agent ("every variant id must appear as a top-level key"), and
 * means agents that skip variants don't get credit-by-omission.
 */

export interface GradeC2Options {
  spec: DetectionTaskSpec;
  taskDir: string;
  /** Per-task grading report destination. */
  reportPath: string;
}

interface TruthRecord {
  kind: MutationKind;
  /** Primary localization anchor. */
  define?: string;
  /**
   * All defines whose body changed for this mutation. For swap mutators
   * this lists two endpoints; either is a valid localization for grading.
   * Older fixtures may omit this field — grader falls back to [define].
   */
  definesAffected?: string[];
  approxLine?: number;
}

export interface GradeC2Result {
  taskId: string;
  agentSubmitted: boolean;
  detection: {
    truePositive: number;
    falsePositive: number;
    trueNegative: number;
    falseNegative: number;
    precision: number;
    recall: number;
    f1: number;
  };
  localization: {
    flagged: number;
    defineCorrect: number;
  };
  classification: {
    flagged: number;
    kindCorrect: number;
  };
  /** Per-mutation-kind recall — how often the agent flags bugs of each kind. */
  perKindRecall: Record<string, { total: number; flagged: number }>;
  perVariant: Array<{
    variantId: string;
    truthHasBug: boolean;
    truthKind: MutationKind;
    truthDefine?: string;
    agentHasBug: boolean | null;
    agentDefine?: string | null;
    agentKind?: MutationKind;
    detectionPass: boolean;
    localizationPass?: boolean;
    classificationPass?: boolean;
  }>;
  parseError?: string;
}

export function gradeC2(opts: GradeC2Options): GradeC2Result {
  const truthPath = join(opts.taskDir, 'groundtruth', 'truth.json');
  if (!existsSync(truthPath)) throw new Error(`truth missing at ${truthPath}`);
  const truth = JSON.parse(readFileSync(truthPath, 'utf8')) as Record<string, TruthRecord>;

  const submission = join(opts.taskDir, 'outputs', 'detections.json');
  if (!existsSync(submission)) {
    return emptyResult(opts.spec, truth, 'no submission');
  }
  let predRaw: unknown;
  try {
    predRaw = JSON.parse(readFileSync(submission, 'utf8'));
  } catch (e) {
    return emptyResult(opts.spec, truth, `detections.json not valid JSON: ${(e as Error).message}`);
  }
  const parsed = DetectionsFileSchema.safeParse(predRaw);
  if (!parsed.success) {
    return emptyResult(opts.spec, truth, `detections.json fails schema: ${parsed.error.message}`);
  }
  const detections = parsed.data;

  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  let locFlagged = 0;
  let locCorrect = 0;
  let classFlagged = 0;
  let classCorrect = 0;
  const perKind: Record<string, { total: number; flagged: number }> = {};
  const perVariant: GradeC2Result['perVariant'] = [];

  for (const variantId of opts.spec.variantIds) {
    const t = truth[variantId];
    if (!t) continue;
    const truthHasBug = t.kind !== 'none';
    const detection: DetectionRecord | undefined = detections[variantId];
    const agentHasBug: boolean | null = detection ? detection.hasBug : false;

    const detectionPass = truthHasBug === agentHasBug;
    if (truthHasBug && agentHasBug) tp += 1;
    else if (!truthHasBug && agentHasBug) fp += 1;
    else if (!truthHasBug && !agentHasBug) tn += 1;
    else fn += 1;

    let localizationPass: boolean | undefined;
    let classificationPass: boolean | undefined;
    if (truthHasBug) {
      // Track per-kind recall on the truth side.
      const k = t.kind;
      if (!perKind[k]) perKind[k] = { total: 0, flagged: 0 };
      perKind[k].total += 1;
      if (agentHasBug) perKind[k].flagged += 1;

      // Localization / classification are only meaningful when both flagged.
      if (agentHasBug) {
        locFlagged += 1;
        const acceptable = t.definesAffected && t.definesAffected.length > 0
          ? t.definesAffected
          : t.define
          ? [t.define]
          : [];
        if (detection?.define && acceptable.includes(detection.define)) {
          locCorrect += 1;
          localizationPass = true;
        } else {
          localizationPass = false;
        }
        if (detection?.mutationKind) {
          classFlagged += 1;
          if (detection.mutationKind === t.kind) {
            classCorrect += 1;
            classificationPass = true;
          } else {
            classificationPass = false;
          }
        }
      }
    }

    perVariant.push({
      variantId,
      truthHasBug,
      truthKind: t.kind,
      ...(t.define !== undefined ? { truthDefine: t.define } : {}),
      agentHasBug,
      ...(detection?.define !== undefined ? { agentDefine: detection.define } : {}),
      ...(detection?.mutationKind !== undefined ? { agentKind: detection.mutationKind } : {}),
      detectionPass,
      ...(localizationPass !== undefined ? { localizationPass } : {}),
      ...(classificationPass !== undefined ? { classificationPass } : {}),
    });
  }

  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  const result: GradeC2Result = {
    taskId: opts.spec.id,
    agentSubmitted: true,
    detection: {
      truePositive: tp,
      falsePositive: fp,
      trueNegative: tn,
      falseNegative: fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
    },
    localization: { flagged: locFlagged, defineCorrect: locCorrect },
    classification: { flagged: classFlagged, kindCorrect: classCorrect },
    perKindRecall: perKind,
    perVariant,
  };
  writeFileSync(opts.reportPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function emptyResult(spec: DetectionTaskSpec, truth: Record<string, TruthRecord>, reason: string): GradeC2Result {
  const perVariant: GradeC2Result['perVariant'] = [];
  let tn = 0;
  let fn = 0;
  for (const variantId of spec.variantIds) {
    const t = truth[variantId];
    if (!t) continue;
    const truthHasBug = t.kind !== 'none';
    if (truthHasBug) fn += 1;
    else tn += 1;
    perVariant.push({
      variantId,
      truthHasBug,
      truthKind: t.kind,
      ...(t.define !== undefined ? { truthDefine: t.define } : {}),
      agentHasBug: null,
      detectionPass: !truthHasBug,
    });
  }
  return {
    taskId: spec.id,
    agentSubmitted: false,
    detection: { truePositive: 0, falsePositive: 0, trueNegative: tn, falseNegative: fn, precision: 1, recall: 0, f1: 0 },
    localization: { flagged: 0, defineCorrect: 0 },
    classification: { flagged: 0, kindCorrect: 0 },
    perKindRecall: {},
    perVariant,
    parseError: reason,
  };
}
