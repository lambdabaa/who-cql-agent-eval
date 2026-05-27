import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AuthoringTaskSpec } from './schema.js';

/**
 * Build the A1 (authoring) task fixture for Measles Low Transmission.
 *
 * The agent will be asked to author the Logic library from a rendered L2
 * decision-table brief (markdown) plus the upstream EncounterElements library
 * as a dependency. Output is graded by:
 *   - T1: cql-to-elm parses the agent's library cleanly.
 *   - T3: agent library + reference deps execute over the existing 7
 *         augmented patients, comparisons match `expected:`.
 *
 * The L2 brief intentionally lists each row, its preconditions (in terms of
 * Encounter helpers), the boolean output define name, and the verbatim
 * guidance string — that is what the WHO L2 workbook actually publishes. The
 * agent's job is to translate the brief into compliant CQL, not to invent the
 * outputs.
 */

export interface BuildA1Options {
  /** Path to the vendored DAK root (e.g. vendor/smart-immunizations). */
  dakRoot: string;
  /** Where to write the task dir. */
  taskDir: string;
}

const TASK_ID = 'A1_measles_low_tx';
const LOGIC_LIB = 'IMMZD2DTMeaslesLowTransmissionLogic';
const PATIENT_PANEL = 'tests/dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml';

const L2_BRIEF = `# IMMZ.D2.DT.Measles.LowTransmission — Decision Table

**Setting:** Countries with low levels of measles transmission.
**Schedule:** MCV1 at 12 months, MCV2 at 15 months.
**Trigger:** \`IMMZ.D2\` — determine required vaccination(s) if any.

The Logic library MUST publish exactly the boolean output defines listed
below, plus the matching \`<output> Guidance\` string defines, plus the
top-level \`Guidance\` and \`Has Guidance\` aggregator defines.

All preconditions reference defines exposed by the
\`IMMZD2DTMeaslesEncounterElements\` library (alias as \`Encounter\`). See
\`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` for the exact names.

## Rows

### Row R1 — \`Client is not due for MCV1 Case 1\`

- Precondition: \`Encounter."Client's age is less than 12 months"\`
- Output define (Boolean): \`Client is not due for MCV1 Case 1\`
- Guidance: \`Should not vaccinate client with MCV1 as client's age is less than 12 months.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.\`

### Row R2 — \`Client is due for MCV1\`

- Preconditions (AND):
  - \`Encounter."No measles primary series doses were administered"\`
  - \`Encounter."Client's age is more than or equal to 12 months"\`
  - \`Encounter."No live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is due for MCV1\`
- Guidance: \`Should vaccinate client with MCV1 as no measles doses were administered, client is within appropriate age range and no live vaccine was administered in the past 4 weeks.\\nCheck for contraindications.\`

### Row R3 — \`Client is not due for MCV1 Case 2\`

- Preconditions (AND):
  - \`Encounter."No measles primary series doses were administered"\`
  - \`Encounter."Client's age is more than or equal to 12 months"\`
  - \`Encounter."Live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is not due for MCV1 Case 2\`
- Guidance: \`Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.\`

### Row R4 — \`Client is not due for MCV2 Case 1\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is less than 15 months"\`
- Output define (Boolean): \`Client is not due for MCV2 Case 1\`
- Guidance: \`Should not vaccinate client with MCV2 as client's age is less than 15 months.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.\`

### Row R5 — \`Client is due for MCV2\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is more than or equal to 15 months"\`
  - \`Encounter."No live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is due for MCV2\`
- Guidance: \`Should vaccinate client with MCV2 as client is within appropriate age range and no live vaccine administered in the past 4 weeks.\\nCheck for contraindications.\`

### Row R6 — \`Client is not due for MCV2 Case 2\`

- Preconditions (AND):
  - \`Encounter."MCV1 was administered"\`
  - \`Encounter."Client's age is more than or equal to 15 months"\`
  - \`Encounter."Live vaccine was administered in the last 4 weeks"\`
- Output define (Boolean): \`Client is not due for MCV2 Case 2\`
- Guidance: \`Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.\`

### Row R7 — \`Measles primary series is complete\`

- Precondition: \`Encounter."MCV2 was administered"\`
- Output define (Boolean): \`Measles primary series is complete\`
- Guidance: \`Measles primary series is complete. Two measles primary series doses were administered.\\nCheck if a measles supplementary dose is appropriate for the client.\`

## Aggregator defines

The library must also include:

- \`Client is not due for MCV1\` = \`"Client is not due for MCV1 Case 1" or "Client is not due for MCV1 Case 2"\`
- \`Client is not due for MCV2\` = \`"Client is not due for MCV2 Case 1" or "Client is not due for MCV2 Case 2"\`
- One \`<output> Guidance\` string define per Boolean output above. The
  Case-1/Case-2 outputs share a \`<aggregator> Guidance\` case-expression
  selecting the correct guidance text (see the convention for "Client is not
  due for MCV1 Guidance" below).
- \`Guidance\` — case-expression returning the active guidance string. Precedence:
  not-due-MCV1 → due-MCV1 → not-due-MCV2 → due-MCV2 → primary-series-complete →
  empty string.
- \`Has Guidance\` = \`"Guidance" is not null and "Guidance" != ''\`.

### Convention for case-aggregated guidance

For "Client is not due for MCV1":

\`\`\`
define "Client is not due for MCV1 Guidance":
  case
    when "Client is not due for MCV1 Case 1" then '<Case 1 guidance>'
    when "Client is not due for MCV1 Case 2" then '<Case 2 guidance>'
    else ''
  end
\`\`\`

For "Client is not due for MCV2" follow the same pattern.
`;

const PROMPT = `# Task A1: Author Measles Low Transmission Logic CQL

You are authoring one CQL Logic library for the WHO SMART Guidelines IMMZ
(Immunizations) DAK against the **L3 CQL SOP**. Output a single file:
\`IMMZD2DTMeaslesLowTransmissionLogic.cql\`.

## What to read

- \`inputs/L2_table.md\` — the decision table (rows, preconditions, output
  define names, guidance strings).
- \`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` — the dependency
  library exposing the \`Encounter.<define>\` helpers your preconditions
  reference. You may also rely on \`FHIRHelpers\` being available.

## Required conventions (WHO L3 CQL SOP)

- \`library IMMZD2DTMeaslesLowTransmissionLogic\` (no \`version\` clause).
- \`using FHIR version '4.0.1'\`.
- \`include FHIRHelpers version '4.0.1'\`.
- \`include IMMZD2DTMeaslesEncounterElements called Encounter\`.
- \`parameter Today Date default Today()\`.
- \`context Patient\`.
- Every boolean output define gets an \`@output:\` annotation in a JSDoc-style
  \`/* ... */\` comment block immediately above its \`define\`.
- Every guidance string define gets an \`@guidance:\` annotation.
- The aggregator \`Guidance\` define gets an \`@dynamicValue: Guidance\`
  annotation.

## Behavioural requirements

- Match the L2 table rows exactly — every Boolean output define listed must
  exist and evaluate to the conjunction/disjunction described.
- Guidance text must be the verbatim string in L2_table.md, with backslash-n
  rendered as a literal newline in the CQL string (use a multi-line
  single-quoted CQL string, e.g. \`'first line\\nsecond line'\` written across
  two source lines, exactly as WHO authors do).
- Apostrophes inside guidance strings must be escaped as \`\\'\` because CQL
  string literals are single-quoted.

## Output

Emit the file as a fenced code block tagged \`path=IMMZD2DTMeaslesLowTransmissionLogic.cql\`.
`;

export function buildA1Fixture(opts: BuildA1Options): { taskDir: string; spec: AuthoringTaskSpec } {
  const taskDir = opts.taskDir;
  mkdirSync(join(taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(taskDir, 'outputs'), { recursive: true });

  writeFileSync(join(taskDir, 'prompt.md'), PROMPT);
  writeFileSync(join(taskDir, 'inputs', 'L2_table.md'), L2_BRIEF);

  const depSrc = join(opts.dakRoot, 'input', 'cql', 'IMMZD2DTMeaslesEncounterElements.cql');
  if (!existsSync(depSrc)) throw new Error(`dependency CQL missing: ${depSrc}`);
  copyFileSync(depSrc, join(taskDir, 'inputs', 'deps', 'IMMZD2DTMeaslesEncounterElements.cql'));

  const spec: AuthoringTaskSpec = {
    id: TASK_ID,
    kind: 'authoring',
    dak: 'smart-immunizations',
    logicLibraryId: LOGIC_LIB,
    outputFiles: ['IMMZD2DTMeaslesLowTransmissionLogic.cql'],
    patientPanelYaml: PATIENT_PANEL,
    today: '2026-01-15',
  };
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(spec, null, 2) + '\n');

  return { taskDir, spec };
}

/** Read a previously-built A1 task spec from disk. */
export function readTaskSpec(taskDir: string): AuthoringTaskSpec {
  const p = join(taskDir, 'task.json');
  if (!existsSync(p)) throw new Error(`task.json missing at ${p}`);
  return JSON.parse(readFileSync(p, 'utf8'));
}

void dirname; // reserved for future use when fixtures span multiple roots
