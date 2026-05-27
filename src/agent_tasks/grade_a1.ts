import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compileCql } from '../harness/compile_cql.js';
import { yamlToBundles } from '../harness/yaml_to_bundle.js';
import { runCase } from '../harness/run_case.js';
import { buildCodeServiceFromFsh } from '../harness/code_service.js';
import type { AuthoringTaskSpec } from './schema.js';

/**
 * Grade an A1 (authoring) submission.
 *
 *  T1 (parse): translate agent CQL + all WHO deps in one batch through
 *      cql-to-elm. Pass iff the translator emits ELM for the agent's library
 *      AND there are no translator errors that name the agent's library.
 *  T3 (execute): swap the agent's library into the compiled corpus (it
 *      replaces the upstream by identifier), run runCase() over every patient
 *      in the panel, compare against the same `expected:` blocks the
 *      reference passes. Score = passed / total.
 *
 * Inputs:
 *  - submissionPath: path to the agent's .cql output file.
 *  - spec: the AuthoringTaskSpec for the task.
 *  - dakRoot: vendored DAK root.
 */

export interface GradeA1Options {
  spec: AuthoringTaskSpec;
  /** Path to the agent's submitted CQL file. */
  submissionPath: string;
  /** Path to the vendored DAK root (vendor/smart-immunizations). */
  dakRoot: string;
  /** Path to the augmented YAML overlay. */
  panelYaml: string;
  /** cql-to-elm jar path; falls back to env. */
  jarPath?: string;
  /** Working dir for the swapped corpus (defaults to .cache/agent-grade/<agent>/<task>). */
  workDir: string;
}

export interface GradeA1Result {
  taskId: string;
  agentSubmitted: boolean;
  t1: 'pass' | 'fail' | 'skip';
  t1Errors: string[];
  t3?: {
    casesTotal: number;
    casesPassed: number;
    perCase: Array<{
      patientId: string;
      passed: boolean;
      comparisons: Array<{ define: string; pass: boolean; expected: unknown; actual: unknown }>;
      runtimeErrors: string[];
    }>;
  };
}

export async function gradeA1(opts: GradeA1Options): Promise<GradeA1Result> {
  if (!existsSync(opts.submissionPath)) {
    return { taskId: opts.spec.id, agentSubmitted: false, t1: 'skip', t1Errors: ['agent produced no submission'] };
  }

  // Stage: copy every WHO .cql into a working dir, then overwrite the target
  // library with the agent's submission. This way the translator sees a
  // self-consistent corpus where exactly one file changed.
  mkdirSync(opts.workDir, { recursive: true });
  const cqlDir = join(opts.workDir, 'cql');
  mkdirSync(cqlDir, { recursive: true });
  const whoCqlDir = join(opts.dakRoot, 'input', 'cql');
  for (const f of readdirSync(whoCqlDir)) {
    if (!f.endsWith('.cql')) continue;
    copyFileSync(join(whoCqlDir, f), join(cqlDir, f));
  }
  copyFileSync(opts.submissionPath, join(cqlDir, `${opts.spec.logicLibraryId}.cql`));

  // T1
  const compileOpts = opts.jarPath ? { sourceDirs: [cqlDir], jarPath: opts.jarPath } : { sourceDirs: [cqlDir] };
  const compiled = compileCql(compileOpts);
  const t1Errors: string[] = [];
  const agentLibName = `${opts.spec.logicLibraryId}.cql`;
  for (const e of compiled.errors) {
    if (e.cqlPath.endsWith(agentLibName) || e.cqlPath === '<batch>') t1Errors.push(`${e.cqlPath}: ${e.stderr.split('\n')[0]}`);
  }
  const agentLib = compiled.libraries.find((l) => l.identifier === opts.spec.logicLibraryId);
  const t1: 'pass' | 'fail' = agentLib && t1Errors.length === 0 ? 'pass' : 'fail';

  if (t1 !== 'pass') {
    if (!agentLib) t1Errors.push(`translator did not emit ELM for ${opts.spec.logicLibraryId}`);
    return { taskId: opts.spec.id, agentSubmitted: true, t1, t1Errors };
  }

  // T3
  const today = opts.spec.today ?? '2026-01-15';
  const parsed = yamlToBundles(readFileSync(opts.panelYaml, 'utf8'), { today });
  const codeService = buildCodeServiceFromFsh({ dakInputDir: join(opts.dakRoot, 'input') });
  const perCaseArr: NonNullable<GradeA1Result['t3']>['perCase'] = [];
  let passed = 0;
  for (const c of parsed.cases) {
    const res = await runCase({
      libraries: compiled.libraries,
      logicLibraryId: opts.spec.logicLibraryId,
      bundle: c.bundle,
      patientId: c.patientId,
      today,
      codeService: codeService.service,
      ...(c.expected ? { expected: c.expected } : {}),
    });
    if (res.passed) passed += 1;
    perCaseArr.push({
      patientId: c.patientId,
      passed: res.passed,
      comparisons: res.comparisons.map((cmp) => ({
        define: cmp.define,
        pass: cmp.pass,
        expected: cmp.expected,
        actual: cmp.actual,
      })),
      runtimeErrors: res.errors,
    });
  }

  // Optional: write a per-task grading report next to the submission.
  const summaryPath = join(opts.workDir, 'grade.json');
  const result: GradeA1Result = {
    taskId: opts.spec.id,
    agentSubmitted: true,
    t1,
    t1Errors,
    t3: { casesTotal: parsed.cases.length, casesPassed: passed, perCase: perCaseArr },
  };
  writeFileSync(summaryPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}
