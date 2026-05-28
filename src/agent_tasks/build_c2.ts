import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_MUTATORS, type Mutation, seededRng } from './c2_mutators.js';
import type { DetectionTaskSpec, MutationKind } from './schema.js';

/**
 * Build a C2 (cross-layer inconsistency detection) fixture.
 *
 * Each fixture targets one Logic library and one L2 brief. The variant plan
 * lists which mutation to inject per variant (or `none` for controls). The
 * shape is shared across libraries — the per-library specialisation is the
 * source CQL, the L2 brief, and the variant plan.
 */

const DEP_CQL = 'IMMZD2DTMeaslesEncounterElements.cql';

export interface VariantPlan {
  id: string;
  kind: MutationKind;
  /** seed for the mutator; ignored for controls */
  seed: number;
}

interface BuildC2FixtureForLibraryOptions {
  /** Task id (e.g. `C2_measles_low_tx`). */
  taskId: string;
  /** Library identifier (e.g. `IMMZD2DTMeaslesLowTransmissionLogic`). */
  libraryName: string;
  /** Human label for the prompt (e.g. `IMMZ.D2.DT.Measles.LowTransmission`). */
  l2RowFamily: string;
  /** Raw markdown content for inputs/L2_table.md. */
  l2BriefContent: string;
  /** Variant plan. */
  variantPlan: VariantPlan[];
  dakRoot: string;
  taskDir: string;
}

function buildC2FixtureForLibrary(opts: BuildC2FixtureForLibraryOptions): { taskDir: string; spec: DetectionTaskSpec } {
  mkdirSync(join(opts.taskDir, 'inputs', 'variants'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'outputs'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'groundtruth'), { recursive: true });

  const libSrc = join(opts.dakRoot, 'input', 'cql', `${opts.libraryName}.cql`);
  const depSrc = join(opts.dakRoot, 'input', 'cql', DEP_CQL);
  if (!existsSync(libSrc)) throw new Error(`source CQL missing: ${libSrc}`);
  if (!existsSync(depSrc)) throw new Error(`dep CQL missing: ${depSrc}`);
  const source = readFileSync(libSrc, 'utf8');

  writeFileSync(join(opts.taskDir, 'inputs', 'L2_table.md'), opts.l2BriefContent);
  copyFileSync(depSrc, join(opts.taskDir, 'inputs', 'deps', DEP_CQL));

  const truth: Record<string, {
    kind: MutationKind;
    define?: string;
    definesAffected?: string[];
    approxLine?: number;
    original?: string;
    modified?: string;
  }> = {};
  const usedMutatedSources = new Set<string>();
  for (const v of opts.variantPlan) {
    let variantSource: string;
    let mutation: Mutation | null = null;
    if (v.kind === 'none') {
      variantSource = source;
    } else {
      const mutator = ALL_MUTATORS[v.kind];
      // Try increasing seeds until the produced source is distinct from any
      // earlier mutated variant — avoids accidentally generating duplicate
      // bugs when a kind has few candidate sites in this library.
      let attemptSeed = v.seed;
      let result = mutator(source, seededRng(attemptSeed));
      let attempts = 0;
      while (usedMutatedSources.has(result.source) && attempts < 50) {
        attemptSeed += 1;
        result = mutator(source, seededRng(attemptSeed));
        attempts += 1;
      }
      if (usedMutatedSources.has(result.source)) {
        throw new Error(`${v.id}: could not produce a unique ${v.kind} variant after ${attempts} retries — library is too small for the plan`);
      }
      usedMutatedSources.add(result.source);
      variantSource = result.source;
      mutation = result.mutation;
    }
    writeFileSync(join(opts.taskDir, 'inputs', 'variants', `${v.id}.cql`), variantSource);
    truth[v.id] = mutation
      ? {
          kind: mutation.kind,
          define: mutation.define,
          definesAffected: mutation.definesAffected,
          approxLine: mutation.approxLine,
          original: mutation.original,
          modified: mutation.modified,
        }
      : { kind: 'none' };
  }

  writeFileSync(join(opts.taskDir, 'groundtruth', 'truth.json'), JSON.stringify(truth, null, 2) + '\n');
  writeFileSync(join(opts.taskDir, 'prompt.md'), renderPrompt({
    l2RowFamily: opts.l2RowFamily,
    libraryName: opts.libraryName,
    variantCount: opts.variantPlan.length,
  }));

  const spec: DetectionTaskSpec = {
    id: opts.taskId,
    kind: 'detection',
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

function renderPrompt(p: { l2RowFamily: string; libraryName: string; variantCount: number }): string {
  return `# Task C2: Detect inconsistencies between L2 brief and Logic CQL

You are given:

- \`inputs/L2_table.md\` — the canonical L2 decision table for ${p.l2RowFamily}.
- \`inputs/deps/${DEP_CQL}\` — the dependency library exposing \`Encounter."…"\` helpers the variants call into.
- \`inputs/variants/v01.cql\` through \`inputs/variants/v${String(p.variantCount).padStart(2, '0')}.cql\` — ${p.variantCount} candidate Logic libraries (\`${p.libraryName}\`). Each is either:
  - byte-identical to a known-good reference (a "control"), or
  - has exactly one injected bug from the taxonomy below.

The corpus is balanced — roughly half the variants are mutated, half are controls.

## Bug taxonomy

You may classify each detection as one of:

- \`boolean_op_flip\` — an \`and\`/\`or\` token is swapped at the start of a continuation line.
- \`reference_rename\` — an \`Encounter."X"\` reference is swapped for a *different entity* (e.g. \`"MCV1 was administered"\` → \`"MCV2 was administered"\`, or polarity flipped).
- \`threshold_change\` — an \`Encounter."X"\` reference is swapped for one with the same predicate but a different numeric threshold (e.g. \`"…less than 12 months"\` → \`"…less than 15 months"\`). Requires knowing the actual clinical schedule.
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
  }
}
\`\`\`

Rules:

- Every variant id must appear as a top-level key.
- \`hasBug\` is required. \`define\`, \`approximateLine\`, \`mutationKind\`, and \`description\` are optional but each correctly-filled field improves the score.
- The primary metric is \`hasBug\` precision/recall. Localization (\`define\`) and classification (\`mutationKind\`) are secondary axes.
`;
}

// ---------------------------------------------------------------------------
// Per-library fixture entry points
// ---------------------------------------------------------------------------

const LOW_TX_VARIANT_PLAN: VariantPlan[] = [
  // 12 mutated, distributed across 6 mutation kinds.
  { id: 'v01', kind: 'boolean_op_flip', seed: 1001 },
  { id: 'v02', kind: 'boolean_op_flip', seed: 1002 },
  { id: 'v03', kind: 'reference_rename', seed: 1101 },
  { id: 'v04', kind: 'reference_rename', seed: 1102 },
  { id: 'v05', kind: 'threshold_change', seed: 1501 },
  { id: 'v06', kind: 'threshold_change', seed: 1502 },
  { id: 'v07', kind: 'precondition_drop', seed: 1201 },
  { id: 'v08', kind: 'precondition_drop', seed: 1202 },
  { id: 'v09', kind: 'comparator_flip', seed: 1301 },
  { id: 'v10', kind: 'comparator_flip', seed: 1302 },
  { id: 'v11', kind: 'guidance_text_swap', seed: 1401 },
  { id: 'v12', kind: 'guidance_text_swap', seed: 1402 },
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

const MCV0_VARIANT_PLAN: VariantPlan[] = [
  // 12 mutated. No guidance_text_swap variants: MCVDose0 has only one simple-
  // string guidance define (`Consider MCV0. Guidance`); the other guidance is
  // a case-expression, which the v0 swap mutator doesn't target.
  { id: 'v01', kind: 'boolean_op_flip', seed: 2001 },
  { id: 'v02', kind: 'boolean_op_flip', seed: 2002 },
  { id: 'v03', kind: 'boolean_op_flip', seed: 2003 },
  { id: 'v04', kind: 'reference_rename', seed: 2101 },
  { id: 'v05', kind: 'reference_rename', seed: 2102 },
  { id: 'v06', kind: 'threshold_change', seed: 2501 },
  { id: 'v07', kind: 'threshold_change', seed: 2502 },
  { id: 'v08', kind: 'precondition_drop', seed: 2201 },
  { id: 'v09', kind: 'precondition_drop', seed: 2202 },
  { id: 'v10', kind: 'precondition_drop', seed: 2203 },
  { id: 'v11', kind: 'comparator_flip', seed: 2301 },
  { id: 'v12', kind: 'comparator_flip', seed: 2302 },
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

export interface BuildC2Options {
  dakRoot: string;
  taskDir: string;
}

export function buildC2Fixture(opts: BuildC2Options): { taskDir: string; spec: DetectionTaskSpec } {
  // The Low Tx brief is the same one A1 uses — read it off A1's fixture so
  // the two stay byte-identical. (baseline.ts builds A1 before any C2.)
  const lowTxBrief = readFileSync('tasks/A1_measles_low_tx/inputs/L2_table.md', 'utf8');
  return buildC2FixtureForLibrary({
    taskId: 'C2_measles_low_tx',
    libraryName: 'IMMZD2DTMeaslesLowTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.LowTransmission',
    l2BriefContent: lowTxBrief,
    variantPlan: LOW_TX_VARIANT_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

export function buildC2McvDose0Fixture(opts: BuildC2Options): { taskDir: string; spec: DetectionTaskSpec } {
  return buildC2FixtureForLibrary({
    taskId: 'C2_measles_mcv0',
    libraryName: 'IMMZD2DTMeaslesMCVDose0Logic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.MCV0',
    l2BriefContent: MCV0_L2_BRIEF,
    variantPlan: MCV0_VARIANT_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

export function buildC2OngoingTxFixture(opts: BuildC2Options): { taskDir: string; spec: DetectionTaskSpec } {
  return buildC2FixtureForLibrary({
    taskId: 'C2_measles_ongoing_tx',
    libraryName: 'IMMZD2DTMeaslesOngoingTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.OngoingTransmission',
    l2BriefContent: ONGOING_TX_L2_BRIEF,
    variantPlan: ONGOING_TX_VARIANT_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

export function buildC2SupplementaryFixture(opts: BuildC2Options): { taskDir: string; spec: DetectionTaskSpec } {
  return buildC2FixtureForLibrary({
    taskId: 'C2_measles_supplementary',
    libraryName: 'IMMZD2DTMeaslesSupplementaryDoseLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.SupplementaryDose',
    l2BriefContent: SUPPLEMENTARY_L2_BRIEF,
    variantPlan: SUPPLEMENTARY_VARIANT_PLAN,
    dakRoot: opts.dakRoot,
    taskDir: opts.taskDir,
  });
}

const ONGOING_TX_VARIANT_PLAN: VariantPlan[] = [
  // 12 mutated, 2 per kind across all 6 kinds.
  { id: 'v01', kind: 'boolean_op_flip', seed: 3001 },
  { id: 'v02', kind: 'boolean_op_flip', seed: 3002 },
  { id: 'v03', kind: 'reference_rename', seed: 3101 },
  { id: 'v04', kind: 'reference_rename', seed: 3102 },
  { id: 'v05', kind: 'threshold_change', seed: 3501 },
  { id: 'v06', kind: 'threshold_change', seed: 3502 },
  { id: 'v07', kind: 'precondition_drop', seed: 3201 },
  { id: 'v08', kind: 'precondition_drop', seed: 3202 },
  { id: 'v09', kind: 'comparator_flip', seed: 3301 },
  { id: 'v10', kind: 'comparator_flip', seed: 3302 },
  { id: 'v11', kind: 'guidance_text_swap', seed: 3401 },
  { id: 'v12', kind: 'guidance_text_swap', seed: 3402 },
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

const SUPPLEMENTARY_VARIANT_PLAN: VariantPlan[] = [
  // 12 mutated. No threshold_change: the supplementary-dose library uses no
  // age helpers, only "supplementary dose was/was not administered" and
  // "live vaccine in past 4 weeks" pairs.
  { id: 'v01', kind: 'boolean_op_flip', seed: 4001 },
  { id: 'v02', kind: 'boolean_op_flip', seed: 4002 },
  { id: 'v03', kind: 'boolean_op_flip', seed: 4003 },
  { id: 'v04', kind: 'reference_rename', seed: 4101 },
  { id: 'v05', kind: 'reference_rename', seed: 4102 },
  { id: 'v06', kind: 'precondition_drop', seed: 4201 },
  { id: 'v07', kind: 'precondition_drop', seed: 4202 },
  { id: 'v08', kind: 'precondition_drop', seed: 4203 },
  { id: 'v09', kind: 'comparator_flip', seed: 4301 },
  { id: 'v10', kind: 'comparator_flip', seed: 4302 },
  { id: 'v11', kind: 'guidance_text_swap', seed: 4401 },
  { id: 'v12', kind: 'guidance_text_swap', seed: 4402 },
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

const ONGOING_TX_L2_BRIEF = `# IMMZ.D2.DT.Measles.OngoingTransmission — Decision Table

**Setting:** Countries with ongoing measles transmission and high mortality risk.
**Schedule:** MCV1 at 9 months, MCV2 at 15 months.
**Trigger:** \`IMMZ.D2\` — determine required vaccination(s) if any.

All preconditions reference defines exposed by the
\`IMMZD2DTMeaslesEncounterElements\` library (alias as \`Encounter\`). See
\`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` for the exact names.

## Rows

### Row R1 — \`Client is not due for first dose of measles-containing vaccine (MCV1)\`

- Precondition: \`Encounter."Client's age is less than 9 months"\`
- Output define (Boolean): \`Client is not due for first dose of measles-containing vaccine (MCV1)\`
- Guidance: \`Should not vaccinate client as client's age is less than 9 months.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.\`

### Row R2 — \`Client is due for MCV1\`

- Preconditions (AND):
  - \`Encounter."No measles primary series doses were administered"\`
  - \`Encounter."Client's age is more than or equal to 9 months"\`
  - \`Encounter."No live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is due for MCV1\`
- Guidance: \`Should vaccinate client with MCV1 as no measles doses were administered, client is within appropriate age range and no live vaccine administered in the past 4 weeks.\\nCheck for contraindications.\`

### Row R3 — \`Client is not due for MCV1\`

- Preconditions (AND):
  - \`Encounter."No measles primary series doses were administered"\`
  - \`Encounter."Client's age is more than or equal to 9 months"\`
  - \`Encounter."Live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is not due for MCV1\`
- Guidance: \`Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.\`

### Row R4 — \`Client is not due for second dose of measles-containing vaccine (MCV2)\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is less than 15 months"\`
- Output define (Boolean): \`Client is not due for second dose of measles-containing vaccine (MCV2)\`
- Guidance: \`Should not vaccinate client with MCV2 as client's age is less than 15 months.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.\`

### Row R5 — \`Client is due for MCV2\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is more than or equal to 15 months"\`
  - \`Encounter."No live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is due for MCV2\`
- Guidance: \`Should vaccinate client with MCV2 as client is within appropriate age range and no live vaccine administered in the past 4 weeks.\\nCheck for contraindications.\`

### Row R6 — \`Client is not due for MCV2\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is more than or equal to 15 months"\`
  - \`Encounter."Live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is not due for MCV2\`
- Guidance: \`Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.\`

### Row R7 — \`Measles primary series is complete\`

- Precondition: \`Encounter."MCV2 was administered"\`
- Output define (Boolean): \`Measles primary series is complete\`
- Guidance: \`Measles primary series is complete. Two measles primary series doses were administered.\\nCheck if a measles supplementary dose is appropriate for the client.\`

## Aggregator defines

- \`Guidance\` — case-expression selecting the appropriate row's guidance string. Precedence: not-due-MCV1-Case1 (age) → due-MCV1 → not-due-MCV1 (live-vaccine) → not-due-MCV2-Case1 (age) → due-MCV2 → not-due-MCV2 (live-vaccine) → primary-series-complete → empty.
- \`Has Guidance\` = \`"Guidance" is not null and "Guidance" != ''\`.

Each row's guidance literal is published as its own \`<row output> Guidance\`
string define (no case-aggregator wrapping like LowTransmission has, because
the cases are distinguished by referenced define name rather than by a
shared "Case 1 / Case 2" naming pattern).
`;

const SUPPLEMENTARY_L2_BRIEF = `# IMMZ.D2.DT.Measles.SupplementaryDose — Decision Table

**Setting:** Determine whether a measles supplementary dose should be administered.
**Trigger:** \`IMMZ.D2\` — determine required vaccination(s) if any.

This decision table runs *after* the primary series is complete. There are no
age preconditions — only "has the supplementary dose already been given?",
"is the routine schedule complete?", and "was a live vaccine given in the
past 4 weeks?".

All preconditions reference defines exposed by the
\`IMMZD2DTMeaslesEncounterElements\` library (alias as \`Encounter\`).

## Rows

### Row R1 — \`Client is not due for measles supplementary dose\`

- Preconditions (AND):
  - \`Encounter."Measles supplementary dose was not administered"\`
  - \`Encounter."Measles routine immunization schedule is complete"\`
  - \`Encounter."Live vaccine was administered in the past 4 weeks"\`
- Output define (Boolean): \`Client is not due for measles supplementary dose\`
- Guidance: \`Should not vaccinate client with measles supplementary dose as live vaccine was administered in the past 4 weeks.\\nCheck for any vaccines due and inform the caregiver of when to come back for supplementary dose.\`

### Row R2 — \`Consider measles supplementary dose. Create a clinical note\`

- Preconditions (AND):
  - \`Encounter."Measles supplementary dose was not administered"\`
  - \`Encounter."Measles routine immunization schedule is complete"\`
  - \`Encounter."No live vaccine was administered in the past 4 weeks"\`
- Output define (Boolean): \`Consider measles supplementary dose. Create a clinical note\` (the trailing period is part of the literal name)
- Guidance: \`May vaccinate client with measles supplementary dose as supplementary dose was not administered, measles routine immunization schedule is complete and no live vaccine administered in the past 4 weeks.\\nCheck if one of the measles supplementary dose specific scenarios is applicable.\`

### Row R3 — \`Measles immunization schedule is complete\`

- Precondition: \`Encounter."Measles supplementary dose was administered"\`
- Output define (Boolean): \`Measles immunization schedule is complete\`
- Guidance: \`Measles immunization schedule is complete. Measles supplementary dose was administered.\`

## Aggregator defines

- \`Guidance\` — case-expression selecting the active row's guidance string.
  Precedence: not-due → consider → schedule-complete → empty.
- \`Has Guidance\` = \`"Guidance" is not null and "Guidance" != ''\`.

Each row's guidance literal is published as its own \`<row output> Guidance\`
string define (no case-aggregator wrapping).
`;

const MCV0_L2_BRIEF = `# IMMZ.D2.DT.Measles.MCV0 — Decision Table

**Setting:** Determine if the client is due for measles-containing vaccine dose 0 (MCV0).
**Schedule:** MCV0 is administered between 6 and 9 months of age, before the routine MCV1 dose.
**Trigger:** \`IMMZ.D2\` — determine required vaccination(s) if any.

The Logic library MUST publish exactly the boolean output defines listed
below, plus the matching \`<output> Guidance\` string defines, plus the
top-level \`Guidance\` and \`Has Guidance\` aggregator defines.

All preconditions reference defines exposed by the
\`IMMZD2DTMeaslesEncounterElements\` library (alias as \`Encounter\`). See
\`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` for the exact names.

## Rows

### Row R1 — \`Client is not due for MCV0 Case 1\`

- Precondition: \`Encounter."Client's age is less than 6 months"\`
- Output define (Boolean): \`Client is not due for MCV0 Case 1\`
- Guidance: \`Should not vaccinate client with MCV0 as client's age is less than 6 months. Check for any vaccines due and inform the caregiver of when to come back for MCV0.\`

### Row R2 — \`Client is not due for MCV0 Case 2\`

- Preconditions (AND):
  - \`Encounter."MCV0 was not administered"\`
  - \`Encounter."Client's age is between 6 months and 9 months"\`
  - \`Encounter."Live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is not due for MCV0 Case 2\`
- Guidance: \`Should not vaccinate client with MCV0 as live vaccine was administered in the past 4 weeks. Check for any vaccines due and inform the caregiver of when to come back for MCV0.\`

### Row R3 — \`Client is not due for MCV0 Case 3\`

- Precondition: \`Encounter."Client's age is more than or equal to 9 months"\`
- Output define (Boolean): \`Client is not due for MCV0 Case 3\`
- Guidance: \`Should not vaccinate client with MCV0 as client's age is more than 9 months.\\nCheck measles routine immunization schedule.\`

### Row R4 — \`Client is not due for MCV0 Case 4\`

- Precondition: \`Encounter."MCV0 was administered"\`
- Output define (Boolean): \`Client is not due for MCV0 Case 4\`
- Guidance: \`MCV0 was administered.\\nCheck measles routine immunization schedule.\`

### Row R5 — \`Consider MCV0.\`

- Preconditions (AND):
  - \`Encounter."MCV0 was not administered"\`
  - \`Encounter."Client's age is between 6 months and 9 months"\`
  - \`Encounter."No live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Consider MCV0.\` (note the trailing period — this is the literal define name)
- Guidance: \`May vaccinate client with MCV0 as client is within appropriate age range, MCV0 was not administered and no live vaccine was administered in the past 4 weeks. Check if one of the MCV0 specific scenarios is applicable.\`

## Aggregator defines

The library must also include:

- \`Client is not due for MCV0\` = \`"Client is not due for MCV0 Case 1" or "Client is not due for MCV0 Case 2" or "Client is not due for MCV0 Case 3" or "Client is not due for MCV0 Case 4"\`
- A \`Client is not due for MCV0 Guidance\` case-expression returning the right per-case guidance string.
- \`Guidance\` — case-expression returning the active guidance string. Precedence:
  not-due-MCV0 → consider-MCV0 → empty string.
- \`Has Guidance\` = \`"Guidance" is not null and "Guidance" != ''\`.

### Convention for case-aggregated guidance

\`\`\`
define "Client is not due for MCV0 Guidance":
  case
    when "Client is not due for MCV0 Case 1" then '<Case 1 guidance>'
    when "Client is not due for MCV0 Case 2" then '<Case 2 guidance>'
    when "Client is not due for MCV0 Case 3" then '<Case 3 guidance>'
    when "Client is not due for MCV0 Case 4" then '<Case 4 guidance>'
    else ''
  end
\`\`\`
`;

