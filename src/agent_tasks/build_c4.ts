import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { yamlToBundles } from '../harness/yaml_to_bundle.js';
import { compileCql } from '../harness/compile_cql.js';
import { runCase } from '../harness/run_case.js';
import { buildCodeServiceFromFsh } from '../harness/code_service.js';
import type { PredictionTaskSpec, PredictionsFile } from './schema.js';

/**
 * Build the C4 (prediction) task fixture for Measles Low Transmission.
 *
 * Setup:
 *  - The Logic library source is given to the agent as-is.
 *  - Each patient's FHIR Bundle (what the harness feeds cql-execution) is
 *    serialized to `inputs/patients/<id>.json`.
 *  - Groundtruth per-patient define values are captured by actually running
 *    reference T3 at fixture-build time and dumped to
 *    `groundtruth/predictions.json`. The grader compares the agent's
 *    `outputs/predictions.json` against this.
 *
 * Why ship the source library? C4 asks the agent to *predict* without
 * executing. Hiding the library would change the task to "predict from L2";
 * that is task A1 with an execution check at the end. C4 is specifically the
 * "read code, simulate execution mentally" task, so the agent gets the code.
 */

const TASK_ID = 'C4_measles_low_tx';
const LOGIC_LIB = 'IMMZD2DTMeaslesLowTransmissionLogic';
const PATIENT_PANEL = 'tests/dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml';
const TODAY = '2026-01-15';

// Headline defines we ask the agent to predict per patient. These are the
// rows WHO uses to drive the PlanDefinition, plus the aggregator Guidance and
// Has Guidance. Per-Case guidance string defines are intentionally excluded —
// they are intermediate, not headline outputs.
const PREDICTED_DEFINES = [
  'Client is not due for MCV1 Case 1',
  'Client is not due for MCV1 Case 2',
  'Client is not due for MCV1',
  'Client is due for MCV1',
  'Client is not due for MCV2 Case 1',
  'Client is not due for MCV2 Case 2',
  'Client is not due for MCV2',
  'Client is due for MCV2',
  'Measles primary series is complete',
  'Has Guidance',
  'Guidance',
];

const PROMPT_TEMPLATE = `# Task C4: Predict CQL define outputs without executing

You are given one WHO SMART Guidelines Logic library, its immediate
dependency (\`IMMZD2DTMeaslesEncounterElements\`), and a set of patient FHIR
Bundles. For each patient, predict the value of the listed CQL defines as if
you had executed the library.

You may not run code. Reason through the CQL by hand.

## Inputs

- \`inputs/library.cql\` — the Logic library (\`${LOGIC_LIB}\`).
- \`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql\` — the Encounter helper
  library (the Logic library calls into this via \`Encounter."…"\`).
- \`inputs/patients/<patientId>.json\` — one FHIR Bundle per patient. The
  Bundle is exactly what the harness loads into cql-execution.

## Evaluation context

- \`Today\` parameter is fixed to \`${TODAY}\` for every patient.
- \`EncounterId\` is \`null\` (no Encounter resource is present).
- Patient context (no separate Encounter scope).

## Defines to predict

For every patient listed in \`task.json\`, predict the value of every define
listed in \`task.json.defines\`. Booleans are \`true\` or \`false\`. Strings
are the exact string the library would return (an empty string \`""\` if the
library's case-expression falls through to \`''\`).

## Output format

Write \`outputs/predictions.json\` as JSON in this exact shape:

\`\`\`json
{
  "<patientId>": {
    "<define name>": <value>,
    ...
  },
  ...
}
\`\`\`

Values must be JSON scalars: \`true\`, \`false\`, a string, a number, or
\`null\`. Do not include any other top-level keys.

Emit the file as a fenced block tagged \`path=predictions.json\`.
`;

export interface BuildC4Options {
  dakRoot: string;
  taskDir: string;
  /** Path to the augmented YAML with `expected:` blocks. */
  panelYaml: string;
  /** cql-to-elm jar path; falls back to env CQL_TO_ELM_JAR. */
  jarPath?: string;
}

export async function buildC4Fixture(opts: BuildC4Options): Promise<{ taskDir: string; spec: PredictionTaskSpec }> {
  const taskDir = opts.taskDir;
  mkdirSync(join(taskDir, 'inputs', 'patients'), { recursive: true });
  mkdirSync(join(taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(taskDir, 'outputs'), { recursive: true });
  mkdirSync(join(taskDir, 'groundtruth'), { recursive: true });

  // 1. Stage the library source + immediate dep.
  const libSrc = join(opts.dakRoot, 'input', 'cql', `${LOGIC_LIB}.cql`);
  const depSrc = join(opts.dakRoot, 'input', 'cql', 'IMMZD2DTMeaslesEncounterElements.cql');
  for (const p of [libSrc, depSrc]) if (!existsSync(p)) throw new Error(`source CQL missing: ${p}`);
  copyFileSync(libSrc, join(taskDir, 'inputs', 'library.cql'));
  copyFileSync(depSrc, join(taskDir, 'inputs', 'deps', 'IMMZD2DTMeaslesEncounterElements.cql'));

  // 2. Render every patient bundle.
  const yamlText = readFileSync(opts.panelYaml, 'utf8');
  const parsed = yamlToBundles(yamlText, { today: TODAY });
  const patientIds: string[] = [];
  for (const c of parsed.cases) {
    writeFileSync(join(taskDir, 'inputs', 'patients', `${c.patientId}.json`), JSON.stringify(c.bundle, null, 2));
    patientIds.push(c.patientId);
  }

  // 3. Capture groundtruth by running reference T3 over the corpus.
  const cqlDir = join(opts.dakRoot, 'input', 'cql');
  const compileOpts = opts.jarPath ? { sourceDirs: [cqlDir], jarPath: opts.jarPath } : { sourceDirs: [cqlDir] };
  const compiled = compileCql(compileOpts);
  const codeService = buildCodeServiceFromFsh({ dakInputDir: join(opts.dakRoot, 'input') });
  const groundtruth: PredictionsFile = {};
  for (const c of parsed.cases) {
    const res = await runCase({
      libraries: compiled.libraries,
      logicLibraryId: LOGIC_LIB,
      bundle: c.bundle,
      patientId: c.patientId,
      today: TODAY,
      codeService: codeService.service,
    });
    const row: Record<string, boolean | string | number | null> = {};
    for (const d of PREDICTED_DEFINES) {
      const v = res.results[d];
      row[d] = normalizeScalar(v);
    }
    groundtruth[c.patientId] = row;
  }
  writeFileSync(join(taskDir, 'groundtruth', 'predictions.json'), JSON.stringify(groundtruth, null, 2) + '\n');

  // 4. Write the prompt + task.json.
  writeFileSync(join(taskDir, 'prompt.md'), PROMPT_TEMPLATE);
  const spec: PredictionTaskSpec = {
    id: TASK_ID,
    kind: 'prediction',
    dak: 'smart-immunizations',
    logicLibraryId: LOGIC_LIB,
    defines: PREDICTED_DEFINES,
    patientIds,
    outputFiles: ['predictions.json'],
    today: TODAY,
  };
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(spec, null, 2) + '\n');

  return { taskDir, spec };
}

function normalizeScalar(v: unknown): boolean | string | number | null {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') return v;
  // Unexpected — surface a stringified form so the diff still reports it.
  return JSON.stringify(v);
}

export function readC4Spec(taskDir: string): PredictionTaskSpec {
  return JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf8'));
}
