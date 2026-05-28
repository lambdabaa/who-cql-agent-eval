import { z } from 'zod';

/**
 * Task specification — written as `task.json` at the root of each task dir.
 *
 * Two kinds in v0:
 *   - `authoring` (B1/A1): agent produces one or more CQL files. Grader
 *     swaps them into the compiled corpus and runs T1 (parse) + T3 (execute)
 *     against the same patient panel the reference library passes.
 *   - `prediction` (B3/C4): agent emits a JSON map of per-patient, per-define
 *     predicted values. Grader diffs predictions against the reference T3
 *     execution captured in groundtruth/.
 *
 * The schema is intentionally narrow — adding `modification` (B2) or
 * `expected-block authoring` (A5) is a new variant, not a generalized shape.
 */

export const AuthoringTaskSpecSchema = z
  .object({
    id: z.string(),
    kind: z.literal('authoring'),
    dak: z.string(),
    logicLibraryId: z.string(),
    /** Files the agent must write under outputs/. Relative paths only. */
    outputFiles: z.array(z.string()).min(1),
    /** Optional: which YAML overlay drives the grader's patient panel. */
    patientPanelYaml: z.string().optional(),
    /** Optional: pinned wall-clock anchor for T3 execution. */
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export const PredictionTaskSpecSchema = z
  .object({
    id: z.string(),
    kind: z.literal('prediction'),
    dak: z.string(),
    logicLibraryId: z.string(),
    /** Defines the agent is asked to predict per patient. */
    defines: z.array(z.string()).min(1),
    /** Patient ids the agent must produce predictions for. */
    patientIds: z.array(z.string()).min(1),
    outputFiles: z.array(z.string()).min(1),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

/**
 * Closed vocabulary of bug-injection kinds for C2 (cross-layer inconsistency
 * detection). Every mutator in c2_mutators.ts produces one of these kinds;
 * groundtruth uses these labels; the agent prompt enumerates them as the
 * allowed `mutationKind` values in its detections.json.
 *
 * v0 set (6 kinds + control):
 *  - comparator_flip      `<` ↔ `>=`, `=` ↔ `!=`, etc. in a boolean expression.
 *  - boolean_op_flip      `and` ↔ `or` between conjuncts of a multi-clause define.
 *  - threshold_change     Numeric/duration literal nudged (12 months → 13, 4 weeks → 5).
 *  - reference_rename     A `"Define name"` reference swapped for another valid one.
 *  - precondition_drop    One conjunct removed from a multi-precondition `and`.
 *  - guidance_text_swap   A guidance string swapped with another output's guidance.
 *  - none                 Control variant — library is byte-identical to upstream.
 */
export const MutationKindSchema = z.enum([
  'comparator_flip',
  'boolean_op_flip',
  'threshold_change',
  'reference_rename',
  'precondition_drop',
  'guidance_text_swap',
  'none',
]);
export type MutationKind = z.infer<typeof MutationKindSchema>;

export const DetectionTaskSpecSchema = z
  .object({
    id: z.string(),
    kind: z.literal('detection'),
    dak: z.string(),
    logicLibraryId: z.string(),
    /** Ordered variant ids the agent must judge (matches inputs/variants/<id>.cql). */
    variantIds: z.array(z.string()).min(1),
    /** Mutation kinds present in the corpus — for the prompt enumeration. */
    mutationVocabulary: z.array(MutationKindSchema).min(1),
    outputFiles: z.array(z.string()).min(1),
  })
  .strict();

export const TaskSpecSchema = z.discriminatedUnion('kind', [
  AuthoringTaskSpecSchema,
  PredictionTaskSpecSchema,
  DetectionTaskSpecSchema,
]);

export type AuthoringTaskSpec = z.infer<typeof AuthoringTaskSpecSchema>;
export type PredictionTaskSpec = z.infer<typeof PredictionTaskSpecSchema>;
export type DetectionTaskSpec = z.infer<typeof DetectionTaskSpecSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/**
 * Per-variant detection record — the shape the agent writes for C2 tasks.
 * `hasBug` is the only mandatory field; the rest sharpen the score.
 */
export const DetectionRecordSchema = z
  .object({
    hasBug: z.boolean(),
    define: z.string().nullable().optional(),
    approximateLine: z.number().int().nullable().optional(),
    mutationKind: MutationKindSchema.optional(),
    description: z.string().optional(),
  })
  .strict();

export const DetectionsFileSchema = z.record(z.string(), DetectionRecordSchema);
export type DetectionRecord = z.infer<typeof DetectionRecordSchema>;
export type DetectionsFile = z.infer<typeof DetectionsFileSchema>;

/**
 * Per-patient predicted values — the shape the agent writes to
 * `outputs/predictions.json` for C4-style tasks. Values are JSON scalars only
 * (booleans, strings, numbers, null) so they round-trip cleanly through file
 * I/O; structured CQL values (lists, intervals) are out of scope for v0.
 */
export const PredictionsFileSchema = z.record(
  z.string(),
  z.record(z.string(), z.union([z.boolean(), z.string(), z.number(), z.null()])),
);

export type PredictionsFile = z.infer<typeof PredictionsFileSchema>;
