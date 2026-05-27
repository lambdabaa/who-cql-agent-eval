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

export const TaskSpecSchema = z.discriminatedUnion('kind', [AuthoringTaskSpecSchema, PredictionTaskSpecSchema]);

export type AuthoringTaskSpec = z.infer<typeof AuthoringTaskSpecSchema>;
export type PredictionTaskSpec = z.infer<typeof PredictionTaskSpecSchema>;
export type TaskSpec = z.infer<typeof TaskSpecSchema>;

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
