import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MUTATORS, type Mutation, seededRng } from './c2_mutators.js';
import type { DetectionTaskSpec, MutationKind } from './schema.js';

/**
 * Build the C2 (cross-layer inconsistency detection) fixture.
 *
 * 24 variants: 12 mutated (~3 per kind × 4 kinds, +2 guidance swaps) and 12
 * controls (byte-identical to upstream). Balanced 50/50 so the agent can't
 * game the score by always answering "yes" or always answering "no".
 *
 * The agent sees the L2 brief (same one A1 used), the EncounterElements dep,
 * and inputs/variants/v01..v24.cql. Each variant carries a hidden truth
 * record in groundtruth/truth.json with the injected mutation (or
 * `kind: 'none'` for controls).
 */

const TASK_ID = 'C2_measles_low_tx';
const LOGIC_LIB = 'IMMZD2DTMeaslesLowTransmissionLogic';

interface VariantPlan {
  id: string;
  kind: MutationKind;
  /** seed for the mutator; ignored for controls */
  seed: number;
}

const VARIANT_PLAN: VariantPlan[] = [
  // 12 mutated
  { id: 'v01', kind: 'boolean_op_flip', seed: 1001 },
  { id: 'v02', kind: 'boolean_op_flip', seed: 1002 },
  { id: 'v03', kind: 'boolean_op_flip', seed: 1003 },
  { id: 'v04', kind: 'reference_rename', seed: 1101 },
  { id: 'v05', kind: 'reference_rename', seed: 1102 },
  { id: 'v06', kind: 'reference_rename', seed: 1103 },
  { id: 'v07', kind: 'precondition_drop', seed: 1201 },
  { id: 'v08', kind: 'precondition_drop', seed: 1202 },
  { id: 'v09', kind: 'precondition_drop', seed: 1203 },
  { id: 'v10', kind: 'comparator_flip', seed: 1301 },
  { id: 'v11', kind: 'comparator_flip', seed: 1302 },
  { id: 'v12', kind: 'guidance_text_swap', seed: 1401 },
  // 12 controls
  { id: 'v13', kind: 'none', seed: 0 },
  { id: 'v14', kind: 'none', seed: 0 },
  { id: 'v15', kind: 'none', seed: 0 },
  { id: 'v16', kind: 'none', seed: 0 },
  { id: 'v17', kind: 'none', seed: 0 },
  { id: 'v18', kind: 'none', seed: 0 },
  { id: 'v19', kind: 'none', seed: 0 },
  { id: 'v20', kind: 'none', seed: 0 },
  { id: 'v21', kind: 'none', seed: 0 },
  { id: 'v22', kind: 'none', seed: 0 },
  { id: 'v23', kind: 'none', seed: 0 },
  { id: 'v24', kind: 'none', seed: 0 },
];

const L2_BRIEF_SOURCE = 'tasks/A1_measles_low_tx/inputs/L2_table.md';

const PROMPT = `# Task C2: Detect inconsistencies between L2 brief and Logic CQL

You are given:

- \`inputs/L2_table.md\` — the canonical L2 decision table for IMMZ.D2.DT.Measles.LowTransmission.
- \`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` — the dependency library exposing \`Encounter."…"\` helpers your variants call into.
- \`inputs/variants/v01.cql\` through \`inputs/variants/v24.cql\` — 24 candidate Logic libraries. Each is either:
  - byte-identical to a known-good reference (a "control"), or
  - has exactly one injected bug from the taxonomy below.

The corpus is balanced — roughly half the variants are mutated, half are controls.

## Bug taxonomy

You may classify each detection as one of:

- \`boolean_op_flip\` — an \`and\`/\`or\` token is swapped at the start of a continuation line.
- \`reference_rename\` — an \`Encounter."X"\` reference is swapped for a *valid but wrong* sibling helper (e.g. \`"…12 months"\` → \`"…15 months"\`).
- \`precondition_drop\` — one conjunct of a multi-precondition \`and\` is missing.
- \`guidance_text_swap\` — a \`<X> Guidance\` string literal is swapped with another output's guidance text.
- \`comparator_flip\` — \`is not null\` ↔ \`is null\` or \`!=\` ↔ \`=\` is flipped in a scalar comparison.
- \`none\` — no bug; the variant matches the L2 brief.

## Your job

For each variant, decide whether it diverges from the L2 brief. If it does, identify the define, an approximate line number, and (optionally) the bug kind.

## Output

Emit a single file as a fenced block tagged \`path=detections.json\`:

\`\`\`json
{
  "v01": {
    "hasBug": true,
    "define": "Client is not due for MCV1 Case 2",
    "approximateLine": 49,
    "mutationKind": "boolean_op_flip",
    "description": "first 'and' between conjuncts flipped to 'or'"
  },
  "v02": {
    "hasBug": false
  },
  ...
  "v24": {
    "hasBug": false
  }
}
\`\`\`

Rules:

- Every variant id v01..v24 must appear as a top-level key.
- \`hasBug\` is required. \`define\`, \`approximateLine\`, \`mutationKind\`, and \`description\` are optional but each correctly-filled field improves the score.
- The primary metric is \`hasBug\` precision/recall. Localization (\`define\`, \`approximateLine\`) and classification (\`mutationKind\`) are secondary axes.
`;

export interface BuildC2Options {
  dakRoot: string;
  taskDir: string;
}

export function buildC2Fixture(opts: BuildC2Options): { taskDir: string; spec: DetectionTaskSpec } {
  mkdirSync(join(opts.taskDir, 'inputs', 'variants'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'outputs'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'groundtruth'), { recursive: true });

  const libSrc = join(opts.dakRoot, 'input', 'cql', `${LOGIC_LIB}.cql`);
  const depSrc = join(opts.dakRoot, 'input', 'cql', 'IMMZD2DTMeaslesEncounterElements.cql');
  if (!existsSync(libSrc)) throw new Error(`source CQL missing: ${libSrc}`);
  if (!existsSync(depSrc)) throw new Error(`dep CQL missing: ${depSrc}`);
  const source = readFileSync(libSrc, 'utf8');

  // L2 brief comes from the A1 fixture so the two stay in sync.
  if (!existsSync(L2_BRIEF_SOURCE)) {
    throw new Error(`L2 brief missing at ${L2_BRIEF_SOURCE} — run \`baseline build\` to materialise the A1 fixture first`);
  }
  copyFileSync(L2_BRIEF_SOURCE, join(opts.taskDir, 'inputs', 'L2_table.md'));
  copyFileSync(depSrc, join(opts.taskDir, 'inputs', 'deps', 'IMMZD2DTMeaslesEncounterElements.cql'));

  const truth: Record<string, { kind: MutationKind; define?: string; approxLine?: number; original?: string; modified?: string }> = {};
  for (const v of VARIANT_PLAN) {
    let variantSource: string;
    let mutation: Mutation | null = null;
    if (v.kind === 'none') {
      variantSource = source;
    } else if (v.kind === 'threshold_change') {
      // Not implemented for v0 — skip.
      throw new Error('threshold_change not implemented for v0');
    } else {
      const mutator = ALL_MUTATORS[v.kind];
      const result = mutator(source, seededRng(v.seed));
      variantSource = result.source;
      mutation = result.mutation;
    }
    writeFileSync(join(opts.taskDir, 'inputs', 'variants', `${v.id}.cql`), variantSource);
    truth[v.id] = mutation
      ? {
          kind: mutation.kind,
          define: mutation.define,
          approxLine: mutation.approxLine,
          original: mutation.original,
          modified: mutation.modified,
        }
      : { kind: 'none' };
  }

  writeFileSync(join(opts.taskDir, 'groundtruth', 'truth.json'), JSON.stringify(truth, null, 2) + '\n');
  writeFileSync(join(opts.taskDir, 'prompt.md'), PROMPT);

  const spec: DetectionTaskSpec = {
    id: TASK_ID,
    kind: 'detection',
    dak: 'smart-immunizations',
    logicLibraryId: LOGIC_LIB,
    variantIds: VARIANT_PLAN.map((v) => v.id),
    mutationVocabulary: [
      'boolean_op_flip',
      'reference_rename',
      'precondition_drop',
      'guidance_text_swap',
      'comparator_flip',
      'none',
    ],
    outputFiles: ['detections.json'],
  };
  writeFileSync(join(opts.taskDir, 'task.json'), JSON.stringify(spec, null, 2) + '\n');
  return { taskDir: opts.taskDir, spec };
}
