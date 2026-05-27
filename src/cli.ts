#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yamlToBundles } from './harness/yaml_to_bundle.js';
import { compileCql } from './harness/compile_cql.js';
import { runCase } from './harness/run_case.js';
import { summarizeTask, aggregateRun, writeJsonReport, writeJunitReport } from './harness/report.js';
import { backfillFromPaths, renderExpectedBlock } from './harness/backfill_expected.js';
import { buildCodeServiceFromFsh } from './harness/code_service.js';
import {
  buildTaskFixtures,
  defaultBaselinePaths,
  freezeBaseline,
  gradeAllRuns,
  runAgentOnAllTasks,
  runnerFromId,
} from './agent_tasks/baseline.js';

/**
 * `who-eval` — top-level CLI for the harness.
 *
 * Two commands:
 *   `run`      — execute the harness against one DAK / decision table.
 *   `backfill` — scrape WHO comments + Test Validation define into draft
 *                `expected:` YAML blocks for human review.
 */

const program = new Command();
program.name('who-eval').description('WHO SMART Guidelines CQL agent evaluation harness').version('0.0.1');

program
  .command('run')
  .description('Run the harness against one decision table')
  .option('--dak <name>', 'DAK submodule name under vendor/', 'smart-immunizations')
  .option('--table <id>', 'Logic library identifier to evaluate', 'IMMZD2DTMeaslesLowTransmissionLogic')
  .option('--yaml <path>', 'Augmented YAML file with `expected:` blocks. Defaults to tests/dak/<table>.yaml')
  .option('--today <date>', 'Wall-clock anchor (YYYY-MM-DD)', '2026-01-15')
  .option('--out <dir>', 'Output directory for reports', 'reports')
  .option('--jar <path>', 'cql-to-elm.jar path (else CQL_TO_ELM_JAR env)')
  .option('--skip-compile', 'Skip T1 (parse). Use only if .cache/elm is already warm.')
  .action(async (opts) => {
    const dakRoot = resolve(`vendor/${opts.dak}`);
    if (!existsSync(dakRoot)) {
      console.error(`DAK submodule not found at ${dakRoot}`);
      process.exit(1);
    }
    const yamlPath = opts.yaml ?? join('tests', 'dak', `${opts.table}.yaml`);
    if (!existsSync(yamlPath)) {
      console.error(`expected-augmented YAML not found at ${yamlPath}`);
      process.exit(1);
    }

    const startedAt = new Date().toISOString();
    const today: string = opts.today;
    const yamlText = readFileSync(yamlPath, 'utf8');
    const parsed = yamlToBundles(yamlText, { today });

    const codeServiceResult = buildCodeServiceFromFsh({ dakInputDir: join(dakRoot, 'input') });
    const valueSetCount = Object.keys(codeServiceResult.map).length;
    if (valueSetCount > 0) console.log(`loaded ${valueSetCount} ValueSets from FSH`);

    let libraries: ReturnType<typeof compileCql>['libraries'] = [];
    if (!opts.skipCompile) {
      const cqlDir = join(dakRoot, 'input', 'cql');
      try {
        const compiled = compileCql({
          sourceDirs: [cqlDir],
          ...(opts.jar ? { jarPath: opts.jar } : {}),
        });
        libraries = compiled.libraries;
        if (compiled.errors.length > 0) {
          console.warn(`cql-to-elm reported ${compiled.errors.length} translation errors`);
          for (const e of compiled.errors.slice(0, 5)) console.warn(`  ${e.cqlPath}: ${e.stderr.split('\n')[0]}`);
        }
        console.log(`compiled ${libraries.length} libraries (hits=${compiled.cacheHits} misses=${compiled.cacheMisses})`);
      } catch (e) {
        console.warn(`T1 (parse) skipped: ${(e as Error).message}`);
      }
    }

    const cases = await Promise.all(
      parsed.cases.map((c) =>
        runCase({
          libraries,
          logicLibraryId: opts.table,
          bundle: c.bundle,
          patientId: c.patientId,
          today,
          codeService: codeServiceResult.service,
          ...(c.expected ? { expected: c.expected } : {}),
        }),
      ),
    );

    const task = summarizeTask({
      taskId: `${opts.dak}/${opts.table}`,
      dak: opts.dak,
      table: opts.table,
      logicLibraryId: opts.table,
      cases,
    });

    const report = aggregateRun({
      startedAt,
      today,
      sourceRevision: parsed.sourceRevision,
      tasks: [task],
    });

    const outDir = opts.out;
    const jsonPath = writeJsonReport(report, join(outDir, 'report.json'));
    const junitPath = writeJunitReport(report, join(outDir, 'junit.xml'));
    console.log(`wrote ${jsonPath}`);
    console.log(`wrote ${junitPath}`);

    console.log('');
    console.log(`T3 execute: ${task.tiers.t3_execute}`);
    console.log(`cases: ${report.totals.casesPassed}/${report.totals.cases} passed`);
    for (const d of task.diagnostics.slice(0, 20)) console.log(`  ${d.tier}: ${d.message}`);

    process.exit(task.tiers.t3_execute === 'pass' ? 0 : 1);
  });

program
  .command('backfill')
  .description('Generate draft `expected:` YAML from WHO `### …` comments and Test Validation define')
  .requiredOption('--yaml <path>', 'WHO examples.yaml path')
  .requiredOption('--cql <path>', 'Logic library .cql path containing Test Validation')
  .option(
    '--defines <list>',
    'Comma-separated list of known define names to detect in YAML comments (default: derived from CQL)',
  )
  .action((opts) => {
    const defines = opts.defines ? (opts.defines as string).split(',').map((s) => s.trim()) : extractDefines(opts.cql);
    const cases = backfillFromPaths(opts.yaml, opts.cql, defines);
    for (const c of cases) {
      console.log(`# ${c.patientId}`);
      console.log(renderExpectedBlock(c));
      console.log('');
    }
  });

function extractDefines(cqlPath: string): string[] {
  const src = readFileSync(cqlPath, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^define\s+"([^"]+)"\s*:/gm)) names.add(m[1]!);
  return [...names];
}

// ---------------------------------------------------------------------------
// baseline — orchestrate (build → run → grade → freeze) for the v0 frontier-
// agent baseline. Each subcommand is independently runnable.
// ---------------------------------------------------------------------------

const baseline = program.command('baseline').description('Build, run, and freeze the v0 agent baseline');

baseline
  .command('build')
  .description('Regenerate canonical task fixtures under tasks/')
  .option('--jar <path>', 'cql-to-elm.jar path (else CQL_TO_ELM_JAR env)')
  .action(async (opts) => {
    const paths = defaultBaselinePaths();
    await buildTaskFixtures(paths, opts.jar ? { jarPath: opts.jar } : {});
    console.log(`built fixtures under ${paths.tasksRoot}`);
  });

baseline
  .command('run')
  .description('Run one or more agents against every task fixture')
  .requiredOption('--agent <spec...>', 'Agent spec(s) like anthropic:claude-opus-4-7 or openai:gpt-5.5')
  .option('--force', 'Re-run even if outputs/ already exist', false)
  .action(async (opts) => {
    const paths = defaultBaselinePaths();
    const agents: string[] = opts.agent;
    for (const a of agents) {
      const runner = runnerFromId(a);
      await runAgentOnAllTasks(paths, runner, { force: opts.force });
    }
  });

baseline
  .command('grade')
  .description('Grade every agent run under runs/, write per-run grade.json')
  .option('--jar <path>', 'cql-to-elm.jar path (else CQL_TO_ELM_JAR env)')
  .action(async (opts) => {
    const paths = defaultBaselinePaths();
    const graded = await gradeAllRuns(paths, opts.jar ? { jarPath: opts.jar } : {});
    for (const g of graded) {
      const r = g.result;
      if ('t1' in r) {
        const t3 = r.t3 ? ` · T3: ${r.t3.casesPassed}/${r.t3.casesTotal}` : '';
        console.log(`${g.agentId}/${g.taskId}: T1=${r.t1}${t3}`);
      } else {
        console.log(`${g.agentId}/${g.taskId}: ${r.correctCells}/${r.totalCells}`);
      }
    }
  });

baseline
  .command('freeze')
  .description('Roll up all grade.json files into baselines/<date>/summary.json')
  .option('--date <iso-day>', 'Date folder (defaults to today)')
  .option('--jar <path>', 'cql-to-elm.jar path (else CQL_TO_ELM_JAR env)')
  .action(async (opts) => {
    const paths = defaultBaselinePaths();
    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const graded = await gradeAllRuns(paths, opts.jar ? { jarPath: opts.jar } : {});
    const out = freezeBaseline(paths, graded, date);
    console.log(`wrote ${out}`);
  });

program.parseAsync(process.argv);
