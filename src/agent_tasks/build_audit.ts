import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AuditTaskSpec } from './schema.js';

/**
 * Build C2's sibling: audit mode. Same input shape (L2 brief + dependency
 * libraries) but the candidate Logic library is the *real, unmodified*
 * published one — not a test variant. The agent is asked to flag any
 * inconsistency it sees.
 *
 * Important caveat baked into the prompt: our L2 briefs were transcribed
 * from the published CQL, not from an independent L2 source. A perfect
 * match is the expected default. False positives are interpretively
 * useful — they tell us how readily each agent invents bugs against
 * known-clean material.
 */

const PROMPT_TEMPLATE = (libraryName: string, l2RowFamily: string, depList: string) => `# Task AUDIT: Find any L2 ↔ L3 inconsistencies in a real WHO library

You are given:

- \`inputs/L2_table.md\` — the canonical L2 decision table for ${l2RowFamily}.
- ${depList} — the dependency librar${depList.includes(',') ? 'ies' : 'y'} the library calls into.
- \`inputs/library.cql\` — the **real, unmodified** Logic library (\`${libraryName}\`) as published in the smart-immunizations / smart-anc DAK.

## Important

This is **not a test corpus**. The library is the actual production CQL.
The L2 brief in this task was transcribed by the harness authors from the
published library annotations. A perfect match between brief and library
is the *expected* default state.

Do not invent inconsistencies. Only flag a finding if the library demonstrably
contradicts what the brief says — wrong define name, wrong precondition,
wrong threshold, wrong guidance text, missing conjunct, etc. If everything
matches, return an empty \`findings\` array.

## Output

Emit a single file as a fenced block tagged \`path=findings.json\`:

\`\`\`json
{
  "findings": [
    {
      "define": "Client is due for MCV1",
      "approximateLine": 82,
      "description": "L2 brief specifies preconditions A AND B AND C, but library uses A AND B (missing C).",
      "severity": "high"
    }
  ]
}
\`\`\`

If no findings: \`{"findings": []}\`.

Rules:

- Every \`finding\` must point to a real define in the library and identify
  what specifically diverges from the brief.
- \`severity\` is optional (\`low\` / \`medium\` / \`high\`).
- Do not flag stylistic differences (whitespace, comment formatting, define ordering).
- Do not flag the absence of optional features the brief doesn't require.
`;

interface BuildAuditFixtureOptions {
  taskId: string;
  dakName: string;
  dakRoot: string;
  libraryName: string;
  l2RowFamily: string;
  l2BriefContent: string;
  depCqlNames: string[];
  taskDir: string;
}

function buildAuditFixtureForLibrary(opts: BuildAuditFixtureOptions): { taskDir: string; spec: AuditTaskSpec } {
  mkdirSync(join(opts.taskDir, 'inputs', 'deps'), { recursive: true });
  mkdirSync(join(opts.taskDir, 'outputs'), { recursive: true });

  const libSrc = join(opts.dakRoot, 'input', 'cql', `${opts.libraryName}.cql`);
  if (!existsSync(libSrc)) throw new Error(`source CQL missing: ${libSrc}`);
  copyFileSync(libSrc, join(opts.taskDir, 'inputs', 'library.cql'));

  for (const dep of opts.depCqlNames) {
    const depSrc = join(opts.dakRoot, 'input', 'cql', dep);
    if (!existsSync(depSrc)) throw new Error(`dep CQL missing: ${depSrc}`);
    copyFileSync(depSrc, join(opts.taskDir, 'inputs', 'deps', dep));
  }

  writeFileSync(join(opts.taskDir, 'inputs', 'L2_table.md'), opts.l2BriefContent);

  const depList = opts.depCqlNames.map((d) => `\`inputs/deps/${d}\``).join(', ');
  writeFileSync(join(opts.taskDir, 'prompt.md'), PROMPT_TEMPLATE(opts.libraryName, opts.l2RowFamily, depList));

  const spec: AuditTaskSpec = {
    id: opts.taskId,
    kind: 'audit',
    dak: opts.dakName,
    logicLibraryId: opts.libraryName,
    l2RowFamily: opts.l2RowFamily,
    outputFiles: ['findings.json'],
  };
  writeFileSync(join(opts.taskDir, 'task.json'), JSON.stringify(spec, null, 2) + '\n');
  return { taskDir: opts.taskDir, spec };
}

// ---------------------------------------------------------------------------
// Audit fixture entry points — each reuses an L2 brief from the matching C2
// fixture so the brief content stays in lockstep with C2.
// ---------------------------------------------------------------------------

const MEASLES_DEPS = ['IMMZD2DTMeaslesEncounterElements.cql'];
const ANC_DT08_DEPS = ['ANCConfig.cql', 'ANCConcepts.cql', 'ANCDataElements.cql', 'ANCContactDataElements.cql'];

export interface BuildAuditOptions {
  dakRoot: string;
  taskDir: string;
}

function readBrief(c2TaskName: string): string {
  return readFileSync(`tasks/${c2TaskName}/inputs/L2_table.md`, 'utf8');
}

export function buildAuditMeaslesLowTxFixture(opts: BuildAuditOptions): { taskDir: string; spec: AuditTaskSpec } {
  return buildAuditFixtureForLibrary({
    taskId: 'audit_measles_low_tx',
    dakName: 'smart-immunizations',
    dakRoot: opts.dakRoot,
    libraryName: 'IMMZD2DTMeaslesLowTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.LowTransmission',
    l2BriefContent: readBrief('C2_measles_low_tx'),
    depCqlNames: MEASLES_DEPS,
    taskDir: opts.taskDir,
  });
}

export function buildAuditMeaslesMcv0Fixture(opts: BuildAuditOptions): { taskDir: string; spec: AuditTaskSpec } {
  return buildAuditFixtureForLibrary({
    taskId: 'audit_measles_mcv0',
    dakName: 'smart-immunizations',
    dakRoot: opts.dakRoot,
    libraryName: 'IMMZD2DTMeaslesMCVDose0Logic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.MCV0',
    l2BriefContent: readBrief('C2_measles_mcv0'),
    depCqlNames: MEASLES_DEPS,
    taskDir: opts.taskDir,
  });
}

export function buildAuditMeaslesOngoingTxFixture(opts: BuildAuditOptions): { taskDir: string; spec: AuditTaskSpec } {
  return buildAuditFixtureForLibrary({
    taskId: 'audit_measles_ongoing_tx',
    dakName: 'smart-immunizations',
    dakRoot: opts.dakRoot,
    libraryName: 'IMMZD2DTMeaslesOngoingTransmissionLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.OngoingTransmission',
    l2BriefContent: readBrief('C2_measles_ongoing_tx'),
    depCqlNames: MEASLES_DEPS,
    taskDir: opts.taskDir,
  });
}

export function buildAuditMeaslesSupplementaryFixture(opts: BuildAuditOptions): { taskDir: string; spec: AuditTaskSpec } {
  return buildAuditFixtureForLibrary({
    taskId: 'audit_measles_supplementary',
    dakName: 'smart-immunizations',
    dakRoot: opts.dakRoot,
    libraryName: 'IMMZD2DTMeaslesSupplementaryDoseLogic',
    l2RowFamily: 'IMMZ.D2.DT.Measles.SupplementaryDose',
    l2BriefContent: readBrief('C2_measles_supplementary'),
    depCqlNames: MEASLES_DEPS,
    taskDir: opts.taskDir,
  });
}

export function buildAuditAncDt08Fixture(opts: BuildAuditOptions): { taskDir: string; spec: AuditTaskSpec } {
  return buildAuditFixtureForLibrary({
    taskId: 'audit_anc_dt08',
    dakName: 'smart-anc',
    dakRoot: resolve(opts.dakRoot, '..', 'smart-anc'),
    libraryName: 'ANCDT08',
    l2RowFamily: 'ANC.DT.08 — HIV testing',
    l2BriefContent: readBrief('C2_anc_dt08'),
    depCqlNames: ANC_DT08_DEPS,
    taskDir: opts.taskDir,
  });
}
