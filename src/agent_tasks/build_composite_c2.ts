import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MUTATORS, type Mutation, seededRng } from './c2_mutators.js';
import type { CompositeDetectionTaskSpec, MutationKind } from './schema.js';

/**
 * Composite C2 fixture builder.
 *
 * Each variant has a `kinds: MutationKind[]` array (length 0..5 in v0).
 * Mutators run sequentially on the working source — kind[0] mutates the
 * original, kind[1] mutates kind[0]'s output, etc. The truth record stores
 * every mutation as a list.
 *
 * Why sequential composition: applying two mutations independently and
 * merging is messy (line indices shift). Sequential application is the
 * obvious-correct semantics — "library that had bug X, then someone
 * also introduced bug Y."
 */

interface CompositeVariantPlan {
  id: string;
  /** 0..5 mutation kinds; empty = control. May repeat the same kind. */
  kinds: MutationKind[];
  /** Base seed; per-kind seeds derived as `seed + i * 11`. */
  seed: number;
}

const MEASLES_DEP = 'IMMZD2DTMeaslesEncounterElements.cql';

interface BuildCompositeC2ForLibraryOptions {
  taskId: string;
  libraryName: string;
  l2RowFamily: string;
  depCqlNames: string[];
  l2BriefContent: string;
  variantPlan: CompositeVariantPlan[];
  dakRoot: string;
  taskDir: string;
}

function buildCompositeC2ForLibrary(opts: BuildCompositeC2ForLibraryOptions): {
  taskDir: string;
  spec: CompositeDetectionTaskSpec;
} {
  mkdirSync(join(opts.taskDir, 'inputs', 'variants'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'outputs'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'groundtruth'), { recursive: true });

  const libSrc = join(opts.dakRoot, 'input', 'cql', `${opts.libraryName}.cql`);
  if (!existsSync(libSrc)) throw new Error(`source CQL missing: ${libSrc}`);
  for (const dep of opts.depCqlNames) {
    const depSrc = join(opts.dakRoot, 'input', 'cql', dep);
    if (!existsSync(depSrc)) throw new Error(`dep CQL missing: ${depSrc}`);
    copyFileSync(depSrc, join(opts.taskDir, 'inputs', 'deps', dep));
  }
  const source = readFileSync(libSrc, 'utf8');

  writeFileSync(join(opts.taskDir, 'inputs', 'L2_table.md'), opts.l2BriefContent);

  const truth: Record<string, { mutations: Array<{ kind: MutationKind; define: string; definesAffected: string[]; approxLine: number; original: string; modified: string }> }> = {};
  const usedFinalSources = new Set<string>();

  for (const v of opts.variantPlan) {
    let workingSource = source;
    const mutations: Mutation[] = [];
    if (v.kinds.length > 0) {
      for (let i = 0; i < v.kinds.length; i += 1) {
        const kind = v.kinds[i]!;
        if (kind === 'none') continue;
        const mutator = ALL_MUTATORS[kind];
        let attemptSeed = v.seed + i * 11;
        let result = mutator(workingSource, seededRng(attemptSeed));
        let attempts = 0;
        while (usedFinalSources.has(result.source) && attempts < 50) {
          attemptSeed += 1;
          result = mutator(workingSource, seededRng(attemptSeed));
          attempts += 1;
        }
        workingSource = result.source;
        mutations.push(result.mutation);
      }
      if (usedFinalSources.has(workingSource)) {
        throw new Error(`${v.id}: composite mutation produced a duplicate variant — library is too small or seeds collide`);
      }
      usedFinalSources.add(workingSource);
    }
    writeFileSync(join(opts.taskDir, 'inputs', 'variants', `${v.id}.cql`), workingSource);
    truth[v.id] = {
      mutations: mutations.map((m) => ({
        kind: m.kind,
        define: m.define,
        definesAffected: m.definesAffected,
        approxLine: m.approxLine,
        original: m.original,
        modified: m.modified,
      })),
    };
  }

  writeFileSync(join(opts.taskDir, 'groundtruth', 'truth.json'), JSON.stringify(truth, null, 2) + '\n');
  writeFileSync(
    join(opts.taskDir, 'prompt.md'),
    renderPrompt({
      libraryName: opts.libraryName,
      l2RowFamily: opts.l2RowFamily,
      depCqlNames: opts.depCqlNames,
      variantCount: opts.variantPlan.length,
    }),
  );

  const spec: CompositeDetectionTaskSpec = {
    id: opts.taskId,
    kind: 'composite_detection',
    dak: 'smart-immunizations',
    logicLibraryId: opts.libraryName,
    variantIds: opts.variantPlan.map((v) => v.id),
    mutationVocabulary: [
      'boolean_op_flip',
      'reference_rename',
      'precondition_drop',
      'guidance_text_swap',
      'comparator_flip',
      'threshold_change',
      'none',
    ],
    outputFiles: ['detections.json'],
  };
  writeFileSync(join(opts.taskDir, 'task.json'), JSON.stringify(spec, null, 2) + '\n');
  return { taskDir: opts.taskDir, spec };
}

function renderPrompt(p: { libraryName: string; l2RowFamily: string; depCqlNames: string[]; variantCount: number }): string {
  const depList = p.depCqlNames.map((d) => `\`inputs/deps/${d}\``).join(', ');
  return `# Task COMPOSITE C2: Detect *every* inconsistency between L2 brief and Logic CQL

You are given:

- \`inputs/L2_table.md\` — the canonical L2 decision table for ${p.l2RowFamily}.
- ${depList} — the dependency librar${p.depCqlNames.length === 1 ? 'y' : 'ies'} the variants call into.
- \`inputs/variants/v01.cql\` through \`inputs/variants/v${String(p.variantCount).padStart(2, '0')}.cql\` — ${p.variantCount} candidate Logic libraries (\`${p.libraryName}\`). Each has **0 to 5** injected bugs.

Unlike the single-bug detection task, the number of bugs per variant is
not fixed. Some variants are clean controls (empty \`findings\`); others
have multiple independent bugs you must each flag separately.

## Bug taxonomy

Each finding's \`mutationKind\` may be:

- \`boolean_op_flip\` — an \`and\`/\`or\` token is swapped at a continuation line.
- \`reference_rename\` — an \`Encounter."X"\` reference is swapped for a *different entity*.
- \`threshold_change\` — an \`Encounter."X"\` reference is swapped for one with the same predicate but a different numeric threshold.
- \`precondition_drop\` — one conjunct of a multi-precondition \`and\` is missing.
- \`guidance_text_swap\` — a \`<X> Guidance\` string literal is swapped with another output's guidance text.
- \`comparator_flip\` — \`is not null\` ↔ \`is null\`, \`!=\` ↔ \`=\`, \`>=\` ↔ \`>\`, or \`<=\` ↔ \`<\`.

## Output

Emit a single file as a fenced block tagged \`path=detections.json\`:

\`\`\`json
{
  "v01": { "findings": [] },
  "v07": {
    "findings": [
      {
        "define": "Client is not due for MCV1 Case 2",
        "approximateLine": 49,
        "mutationKind": "boolean_op_flip",
        "description": "'and' flipped to 'or'"
      }
    ]
  }
}
\`\`\`

Rules:

- Every variant id must appear as a top-level key.
- \`findings\` is required (use \`[]\` for controls).
- The primary metric is **set-based F1** over (variant, define) pairs:
  precision = findings that match an injected bug / total findings;
  recall = injected bugs flagged / total injected bugs.
- Localization is matched on \`define\` name; \`mutationKind\` is a secondary
  classification axis. Imprecise \`approximateLine\` is not penalised.
- Do not invent bugs to game recall — false positives cost precision.
`;
}

// ---------------------------------------------------------------------------
// Per-library variant plans
// ---------------------------------------------------------------------------

const LOW_TX_COMPOSITE_PLAN: CompositeVariantPlan[] = [
  // 6 controls
  { id: 'v01', kinds: [], seed: 0 },
  { id: 'v02', kinds: [], seed: 0 },
  { id: 'v03', kinds: [], seed: 0 },
  { id: 'v04', kinds: [], seed: 0 },
  { id: 'v05', kinds: [], seed: 0 },
  { id: 'v06', kinds: [], seed: 0 },
  // 6 single-bug
  { id: 'v07', kinds: ['boolean_op_flip'], seed: 6001 },
  { id: 'v08', kinds: ['reference_rename'], seed: 6002 },
  { id: 'v09', kinds: ['threshold_change'], seed: 6003 },
  { id: 'v10', kinds: ['precondition_drop'], seed: 6004 },
  { id: 'v11', kinds: ['comparator_flip'], seed: 6005 },
  { id: 'v12', kinds: ['guidance_text_swap'], seed: 6006 },
  // 6 two-bug
  { id: 'v13', kinds: ['boolean_op_flip', 'threshold_change'], seed: 6101 },
  { id: 'v14', kinds: ['reference_rename', 'precondition_drop'], seed: 6102 },
  { id: 'v15', kinds: ['comparator_flip', 'guidance_text_swap'], seed: 6103 },
  { id: 'v16', kinds: ['threshold_change', 'reference_rename'], seed: 6104 },
  { id: 'v17', kinds: ['precondition_drop', 'boolean_op_flip'], seed: 6105 },
  { id: 'v18', kinds: ['guidance_text_swap', 'threshold_change'], seed: 6106 },
  // 6 three-bug
  { id: 'v19', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename'], seed: 6201 },
  { id: 'v20', kinds: ['reference_rename', 'precondition_drop', 'comparator_flip'], seed: 6202 },
  { id: 'v21', kinds: ['threshold_change', 'comparator_flip', 'guidance_text_swap'], seed: 6203 },
  { id: 'v22', kinds: ['precondition_drop', 'boolean_op_flip', 'threshold_change'], seed: 6204 },
  { id: 'v23', kinds: ['guidance_text_swap', 'reference_rename', 'precondition_drop'], seed: 6205 },
  { id: 'v24', kinds: ['comparator_flip', 'threshold_change', 'boolean_op_flip'], seed: 6206 },
  // 6 four-bug
  { id: 'v25', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop'], seed: 6301 },
  { id: 'v26', kinds: ['threshold_change', 'comparator_flip', 'guidance_text_swap', 'reference_rename'], seed: 6302 },
  { id: 'v27', kinds: ['precondition_drop', 'boolean_op_flip', 'comparator_flip', 'threshold_change'], seed: 6303 },
  { id: 'v28', kinds: ['reference_rename', 'guidance_text_swap', 'precondition_drop', 'boolean_op_flip'], seed: 6304 },
  { id: 'v29', kinds: ['comparator_flip', 'reference_rename', 'threshold_change', 'guidance_text_swap'], seed: 6305 },
  { id: 'v30', kinds: ['guidance_text_swap', 'precondition_drop', 'boolean_op_flip', 'comparator_flip'], seed: 6306 },
  // 6 five-bug — each holds one kind out.
  { id: 'v31', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip'], seed: 6401 },
  { id: 'v32', kinds: ['threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6402 },
  { id: 'v33', kinds: ['boolean_op_flip', 'reference_rename', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6403 },
  { id: 'v34', kinds: ['boolean_op_flip', 'threshold_change', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6404 },
  { id: 'v35', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'comparator_flip', 'guidance_text_swap'], seed: 6405 },
  { id: 'v36', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop', 'guidance_text_swap'], seed: 6406 },
];

/**
 * OngoingTx mirrors LowTx — same six mutation kinds applicable. Different
 * seed prefix so per-position mutators land on different sites.
 */
const ONGOING_TX_COMPOSITE_PLAN: CompositeVariantPlan[] = LOW_TX_COMPOSITE_PLAN.map((v) => ({
  ...v,
  seed: v.seed === 0 ? 0 : v.seed + 1000,
}));

/**
 * MCV0 has only 1 simple-literal guidance define (`Consider MCV0. Guidance`)
 * so `guidance_text_swap` has no candidate pair. Plan replaces every
 * guidance_text_swap slot with an extra `comparator_flip` or
 * `precondition_drop` and re-orders to keep variant counts even.
 */
const MCV0_COMPOSITE_PLAN: CompositeVariantPlan[] = [
  // 6 controls
  { id: 'v01', kinds: [], seed: 0 },
  { id: 'v02', kinds: [], seed: 0 },
  { id: 'v03', kinds: [], seed: 0 },
  { id: 'v04', kinds: [], seed: 0 },
  { id: 'v05', kinds: [], seed: 0 },
  { id: 'v06', kinds: [], seed: 0 },
  // 6 single-bug — 5 kinds (no guidance_text_swap), one repeat
  { id: 'v07', kinds: ['boolean_op_flip'], seed: 7001 },
  { id: 'v08', kinds: ['reference_rename'], seed: 7002 },
  { id: 'v09', kinds: ['threshold_change'], seed: 7003 },
  { id: 'v10', kinds: ['precondition_drop'], seed: 7004 },
  { id: 'v11', kinds: ['comparator_flip'], seed: 7005 },
  { id: 'v12', kinds: ['boolean_op_flip'], seed: 7006 },
  // 6 two-bug
  { id: 'v13', kinds: ['boolean_op_flip', 'threshold_change'], seed: 7101 },
  { id: 'v14', kinds: ['reference_rename', 'precondition_drop'], seed: 7102 },
  { id: 'v15', kinds: ['comparator_flip', 'threshold_change'], seed: 7103 },
  { id: 'v16', kinds: ['threshold_change', 'reference_rename'], seed: 7104 },
  { id: 'v17', kinds: ['precondition_drop', 'boolean_op_flip'], seed: 7105 },
  { id: 'v18', kinds: ['comparator_flip', 'boolean_op_flip'], seed: 7106 },
  // 6 three-bug
  { id: 'v19', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename'], seed: 7201 },
  { id: 'v20', kinds: ['reference_rename', 'precondition_drop', 'comparator_flip'], seed: 7202 },
  { id: 'v21', kinds: ['threshold_change', 'comparator_flip', 'boolean_op_flip'], seed: 7203 },
  { id: 'v22', kinds: ['precondition_drop', 'boolean_op_flip', 'threshold_change'], seed: 7204 },
  { id: 'v23', kinds: ['comparator_flip', 'reference_rename', 'precondition_drop'], seed: 7205 },
  { id: 'v24', kinds: ['boolean_op_flip', 'reference_rename', 'threshold_change'], seed: 7206 },
  // 6 four-bug — all 5 applicable kinds in different orderings; one repeat per variant
  { id: 'v25', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop'], seed: 7301 },
  { id: 'v26', kinds: ['threshold_change', 'comparator_flip', 'reference_rename', 'boolean_op_flip'], seed: 7302 },
  { id: 'v27', kinds: ['precondition_drop', 'boolean_op_flip', 'comparator_flip', 'threshold_change'], seed: 7303 },
  { id: 'v28', kinds: ['reference_rename', 'comparator_flip', 'precondition_drop', 'boolean_op_flip'], seed: 7304 },
  { id: 'v29', kinds: ['comparator_flip', 'reference_rename', 'threshold_change', 'precondition_drop'], seed: 7305 },
  { id: 'v30', kinds: ['boolean_op_flip', 'precondition_drop', 'comparator_flip', 'threshold_change'], seed: 7306 },
  // 6 five-bug — all 5 kinds, varying order
  { id: 'v31', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip'], seed: 7401 },
  { id: 'v32', kinds: ['threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip', 'boolean_op_flip'], seed: 7402 },
  { id: 'v33', kinds: ['reference_rename', 'precondition_drop', 'comparator_flip', 'boolean_op_flip', 'threshold_change'], seed: 7403 },
  { id: 'v34', kinds: ['precondition_drop', 'comparator_flip', 'boolean_op_flip', 'threshold_change', 'reference_rename'], seed: 7404 },
  { id: 'v35', kinds: ['comparator_flip', 'boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop'], seed: 7405 },
  { id: 'v36', kinds: ['threshold_change', 'precondition_drop', 'reference_rename', 'comparator_flip', 'boolean_op_flip'], seed: 7406 },
];

// ---------------------------------------------------------------------------
// Per-library fixture entry points
// ---------------------------------------------------------------------------

export interface BuildCompositeC2Options {
  dakRoot: string;
  taskDir: string;
}

function readBriefFromC2(c2TaskName: string): string {
  const briefPath = `tasks/${c2TaskName}/inputs/L2_table.md`;
  if (!existsSync(briefPath)) {
    throw new Error(`L2 brief missing at ${briefPath} — run \`baseline build\` to materialise C2 fixtures first`);
  }
  return readFileSync(briefPath, 'utf8');
}

export function buildCompositeC2Fixture(opts: BuildCompositeC2Options): { taskDir: string; spec: CompositeDetectionTaskSpec } {
  return buildCompositeC2ForLibrary({
    taskId: 'composite_c2_measles_low_tx',
    libraryName: 'IMMZD2DTMeaslesLowTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.LowTransmission',
    depCqlNames: [MEASLES_DEP],
    l2BriefContent: readBriefFromC2('C2_measles_low_tx'),
    variantPlan: LOW_TX_COMPOSITE_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

export function buildCompositeC2OngoingTxFixture(opts: BuildCompositeC2Options): { taskDir: string; spec: CompositeDetectionTaskSpec } {
  return buildCompositeC2ForLibrary({
    taskId: 'composite_c2_measles_ongoing_tx',
    libraryName: 'IMMZD2DTMeaslesOngoingTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.OngoingTransmission',
    depCqlNames: [MEASLES_DEP],
    l2BriefContent: readBriefFromC2('C2_measles_ongoing_tx'),
    variantPlan: ONGOING_TX_COMPOSITE_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

export function buildCompositeC2Mcv0Fixture(opts: BuildCompositeC2Options): { taskDir: string; spec: CompositeDetectionTaskSpec } {
  return buildCompositeC2ForLibrary({
    taskId: 'composite_c2_measles_mcv0',
    libraryName: 'IMMZD2DTMeaslesMCVDose0Logic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.MCV0',
    depCqlNames: [MEASLES_DEP],
    l2BriefContent: readBriefFromC2('C2_measles_mcv0'),
    variantPlan: MCV0_COMPOSITE_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}
