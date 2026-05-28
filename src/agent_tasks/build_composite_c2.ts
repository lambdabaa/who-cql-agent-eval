import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MUTATORS, type Mutation, seededRng } from './c2_mutators.js';
import type { CompositeDetectionTaskSpec, MutationKind } from './schema.js';

/**
 * Composite C2 fixture builder.
 *
 * Each variant has a `kinds: MutationKind[]` array (length 0..3 in v0).
 * Mutators run sequentially on the working source — kind[0] mutates the
 * original, kind[1] mutates kind[0]'s output, etc. The truth record stores
 * every mutation as a list.
 *
 * Why sequential composition: applying two mutations independently and
 * merging is messy (line indices shift). Sequential application is the
 * obvious-correct semantics — "library that had bug X, then someone
 * also introduced bug Y."
 *
 * Why a single library for v0: composite is the experiment. Adding more
 * libraries later is mechanical once we know if the discrimination
 * actually shows up.
 */

interface CompositeVariantPlan {
  id: string;
  /** 0..3 mutation kinds; empty = control. */
  kinds: MutationKind[];
  /** Base seed; per-kind seeds derived as `seed + i`. */
  seed: number;
}

const DEP_CQL = 'IMMZD2DTMeaslesEncounterElements.cql';

const LOW_TX_COMPOSITE_PLAN: CompositeVariantPlan[] = [
  // 6 controls (no bugs)
  { id: 'v01', kinds: [], seed: 0 },
  { id: 'v02', kinds: [], seed: 0 },
  { id: 'v03', kinds: [], seed: 0 },
  { id: 'v04', kinds: [], seed: 0 },
  { id: 'v05', kinds: [], seed: 0 },
  { id: 'v06', kinds: [], seed: 0 },
  // 6 single-bug (baseline within composite)
  { id: 'v07', kinds: ['boolean_op_flip'], seed: 6001 },
  { id: 'v08', kinds: ['reference_rename'], seed: 6002 },
  { id: 'v09', kinds: ['threshold_change'], seed: 6003 },
  { id: 'v10', kinds: ['precondition_drop'], seed: 6004 },
  { id: 'v11', kinds: ['comparator_flip'], seed: 6005 },
  { id: 'v12', kinds: ['guidance_text_swap'], seed: 6006 },
  // 6 two-bug variants (mix of kinds)
  { id: 'v13', kinds: ['boolean_op_flip', 'threshold_change'], seed: 6101 },
  { id: 'v14', kinds: ['reference_rename', 'precondition_drop'], seed: 6102 },
  { id: 'v15', kinds: ['comparator_flip', 'guidance_text_swap'], seed: 6103 },
  { id: 'v16', kinds: ['threshold_change', 'reference_rename'], seed: 6104 },
  { id: 'v17', kinds: ['precondition_drop', 'boolean_op_flip'], seed: 6105 },
  { id: 'v18', kinds: ['guidance_text_swap', 'threshold_change'], seed: 6106 },
  // 6 three-bug variants
  { id: 'v19', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename'], seed: 6201 },
  { id: 'v20', kinds: ['reference_rename', 'precondition_drop', 'comparator_flip'], seed: 6202 },
  { id: 'v21', kinds: ['threshold_change', 'comparator_flip', 'guidance_text_swap'], seed: 6203 },
  { id: 'v22', kinds: ['precondition_drop', 'boolean_op_flip', 'threshold_change'], seed: 6204 },
  { id: 'v23', kinds: ['guidance_text_swap', 'reference_rename', 'precondition_drop'], seed: 6205 },
  { id: 'v24', kinds: ['comparator_flip', 'threshold_change', 'boolean_op_flip'], seed: 6206 },
  // 6 four-bug variants — each picks 4 of the 6 kinds.
  { id: 'v25', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop'], seed: 6301 },
  { id: 'v26', kinds: ['threshold_change', 'comparator_flip', 'guidance_text_swap', 'reference_rename'], seed: 6302 },
  { id: 'v27', kinds: ['precondition_drop', 'boolean_op_flip', 'comparator_flip', 'threshold_change'], seed: 6303 },
  { id: 'v28', kinds: ['reference_rename', 'guidance_text_swap', 'precondition_drop', 'boolean_op_flip'], seed: 6304 },
  { id: 'v29', kinds: ['comparator_flip', 'reference_rename', 'threshold_change', 'guidance_text_swap'], seed: 6305 },
  { id: 'v30', kinds: ['guidance_text_swap', 'precondition_drop', 'boolean_op_flip', 'comparator_flip'], seed: 6306 },
  // 6 five-bug variants — each picks 5 of the 6 kinds (one kind held out each).
  { id: 'v31', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip'], seed: 6401 },
  { id: 'v32', kinds: ['threshold_change', 'reference_rename', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6402 },
  { id: 'v33', kinds: ['boolean_op_flip', 'reference_rename', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6403 },
  { id: 'v34', kinds: ['boolean_op_flip', 'threshold_change', 'precondition_drop', 'comparator_flip', 'guidance_text_swap'], seed: 6404 },
  { id: 'v35', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'comparator_flip', 'guidance_text_swap'], seed: 6405 },
  { id: 'v36', kinds: ['boolean_op_flip', 'threshold_change', 'reference_rename', 'precondition_drop', 'guidance_text_swap'], seed: 6406 },
];

const PROMPT_TEMPLATE = (libraryName: string, l2RowFamily: string, variantCount: number) => `# Task COMPOSITE C2: Detect *every* inconsistency between L2 brief and Logic CQL

You are given:

- \`inputs/L2_table.md\` — the canonical L2 decision table for ${l2RowFamily}.
- \`inputs/deps/${DEP_CQL}\` — the dependency library exposing \`Encounter."…"\` helpers the variants call into.
- \`inputs/variants/v01.cql\` through \`inputs/variants/v${String(variantCount).padStart(2, '0')}.cql\` — ${variantCount} candidate Logic libraries (\`${libraryName}\`). Each has **0, 1, 2, or 3** injected bugs.

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
  },
  "v19": {
    "findings": [
      { "define": "...", "mutationKind": "boolean_op_flip" },
      { "define": "...", "mutationKind": "threshold_change" },
      { "define": "...", "mutationKind": "reference_rename" }
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

export interface BuildCompositeC2Options {
  dakRoot: string;
  taskDir: string;
}

export function buildCompositeC2Fixture(opts: BuildCompositeC2Options): {
  taskDir: string;
  spec: CompositeDetectionTaskSpec;
} {
  mkdirSync(join(opts.taskDir, 'inputs', 'variants'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'outputs'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'groundtruth'), { recursive: true });

  const libSrc = join(opts.dakRoot, 'input', 'cql', 'IMMZD2DTMeaslesLowTransmissionLogic.cql');
  const depSrc = join(opts.dakRoot, 'input', 'cql', DEP_CQL);
  if (!existsSync(libSrc)) throw new Error(`source CQL missing: ${libSrc}`);
  if (!existsSync(depSrc)) throw new Error(`dep CQL missing: ${depSrc}`);
  copyFileSync(depSrc, join(opts.taskDir, 'inputs', 'deps', DEP_CQL));
  const source = readFileSync(libSrc, 'utf8');

  // Reuse the A1 L2 brief (same library, same brief).
  const briefPath = 'tasks/A1_measles_low_tx/inputs/L2_table.md';
  if (!existsSync(briefPath)) {
    throw new Error(`L2 brief missing at ${briefPath} — run \`baseline build\` to materialise A1 first`);
  }
  copyFileSync(briefPath, join(opts.taskDir, 'inputs', 'L2_table.md'));

  const truth: Record<string, { mutations: Array<{ kind: MutationKind; define: string; definesAffected: string[]; approxLine: number; original: string; modified: string }> }> = {};
  const usedFinalSources = new Set<string>();
  usedFinalSources.add(source); // controls are all == source; tracked separately below

  for (const v of LOW_TX_COMPOSITE_PLAN) {
    let workingSource = source;
    const mutations: Mutation[] = [];
    if (v.kinds.length > 0) {
      // Apply each mutator sequentially. Bump per-kind seed within the
      // variant; if a particular kind's first try produces a duplicate
      // overall source, bump its seed and retry.
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
    PROMPT_TEMPLATE('IMMZD2DTMeaslesLowTransmissionLogic', 'IMMZ.D2.DT.Measles.LowTransmission', LOW_TX_COMPOSITE_PLAN.length),
  );

  const spec: CompositeDetectionTaskSpec = {
    id: 'composite_c2_measles_low_tx',
    kind: 'composite_detection',
    dak: 'smart-immunizations',
    logicLibraryId: 'IMMZD2DTMeaslesLowTransmissionLogic',
    variantIds: LOW_TX_COMPOSITE_PLAN.map((v) => v.id),
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
