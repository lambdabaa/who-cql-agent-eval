import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { yamlToBundles } from '../../src/harness/yaml_to_bundle.js';
import { compileCql } from '../../src/harness/compile_cql.js';
import { runCase } from '../../src/harness/run_case.js';
import { buildCodeServiceFromFsh } from '../../src/harness/code_service.js';

/**
 * Tier-3 end-to-end: take the augmented Measles overlay, compile the WHO
 * CQL corpus, run every case through cql-execution, and confirm the
 * `expected:` block matches actual execution output.
 *
 * Skips itself if the translator jar isn't available — Tier-1 (parse) is a
 * prerequisite and the build needs Java + Maven (see scripts/fetch_cql_to_elm.sh).
 */

const DAK_ROOT = 'vendor/smart-immunizations';
const OVERLAY = 'tests/dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml';
const TABLE = 'IMMZD2DTMeaslesLowTransmissionLogic';
const TODAY = '2026-01-15';
const JAR = process.env.CQL_TO_ELM_JAR ?? 'tools/cql-to-elm/cql-to-elm.jar';

const jarAvailable = existsSync(JAR);
const describeIfJar = jarAvailable ? describe : describe.skip;

describeIfJar('Tier-3 Measles end-to-end', () => {
  let cases: Awaited<ReturnType<typeof runCase>>[];

  beforeAll(async () => {
    const yamlText = readFileSync(OVERLAY, 'utf8');
    const parsed = yamlToBundles(yamlText, { today: TODAY });
    const compiled = compileCql({ sourceDirs: [join(DAK_ROOT, 'input', 'cql')], jarPath: JAR });
    expect(compiled.errors).toEqual([]);
    expect(compiled.libraries.some((l) => l.identifier === TABLE)).toBe(true);
    expect(compiled.libraries.some((l) => l.identifier === 'FHIRHelpers')).toBe(true);

    const codeService = buildCodeServiceFromFsh({ dakInputDir: join(DAK_ROOT, 'input') }).service;

    cases = await Promise.all(
      parsed.cases.map((c) =>
        runCase({
          libraries: compiled.libraries,
          logicLibraryId: TABLE,
          bundle: c.bundle,
          patientId: c.patientId,
          today: TODAY,
          codeService,
          ...(c.expected ? { expected: c.expected } : {}),
        }),
      ),
    );
  }, 180_000);

  it('passes for every Measles Low Transmission patient', () => {
    const failures = cases
      .filter((c) => !c.passed)
      .map((c) => ({
        patientId: c.patientId,
        errors: c.errors,
        failingDefines: c.comparisons.filter((cmp) => !cmp.pass).map((cmp) => cmp.define),
      }));
    expect(failures).toEqual([]);
  });

  it('evaluates a non-empty set of defines for every case', () => {
    for (const c of cases) {
      expect(c.comparisons.length, `case ${c.patientId}`).toBeGreaterThan(0);
    }
  });
});
