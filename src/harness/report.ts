import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunCaseResult } from './run_case.js';

/**
 * Per-tier breakdown of one task's outcome.
 *
 * Tier weights deliberately are not collapsed into a single score — a
 * T3-pass+T0-fail outcome is a different failure mode than the inverse,
 * and the rubric (§4.5) requires that both stay visible.
 */
export type TierStatus = 'pass' | 'fail' | 'skipped' | 'not-applicable';

export interface TierReport {
  t0_style: TierStatus;
  t1_parse: TierStatus;
  t2_type: TierStatus;
  t3_execute: TierStatus;
  t4_measure: TierStatus;
  t5_semantic: TierStatus;
}

export interface TaskReport {
  taskId: string;
  /** DAK identifier (e.g. `smart-immunizations`). */
  dak: string;
  /** Decision table or library being targeted. */
  table: string;
  /** Logic library being executed. */
  logicLibraryId: string;
  /** One row per (patient, case). */
  cases: RunCaseResult[];
  /** Tier summary across all cases for the task. */
  tiers: TierReport;
  /** Where applicable, per-tier diagnostic messages. */
  diagnostics: Array<{ tier: keyof TierReport; message: string }>;
}

export interface RunReport {
  /** ISO timestamp of when the run started. */
  startedAt: string;
  /** Wall-clock anchor used for the run. */
  today: string;
  /** Pinned source revision (e.g. `smart-immunizations@b16245f71`). */
  sourceRevision: string;
  /** Per-task results. */
  tasks: TaskReport[];
  /** Aggregate pass count for the headline; per-tier breakdown follows. */
  totals: {
    cases: number;
    casesPassed: number;
    tasks: number;
    tasksPassed: number;
  };
}

export function summarizeTask(taskReport: Omit<TaskReport, 'tiers' | 'diagnostics'>): TaskReport {
  const diagnostics: TaskReport['diagnostics'] = [];

  const anyExecuteErrors = taskReport.cases.some((c) => c.errors.length > 0);
  const anyComparisonFail = taskReport.cases.some((c) => c.comparisons.some((cmp) => !cmp.pass));
  const anyComparisons = taskReport.cases.some((c) => c.comparisons.length > 0);

  const t3_execute: TierStatus = anyExecuteErrors
    ? 'fail'
    : anyComparisons
      ? anyComparisonFail
        ? 'fail'
        : 'pass'
      : 'skipped';

  if (anyExecuteErrors) {
    for (const c of taskReport.cases) {
      for (const err of c.errors) diagnostics.push({ tier: 't3_execute', message: `[${c.patientId}] ${err}` });
    }
  }
  if (anyComparisonFail) {
    for (const c of taskReport.cases) {
      for (const cmp of c.comparisons) {
        if (!cmp.pass) {
          diagnostics.push({
            tier: 't3_execute',
            message: `[${c.patientId}] ${cmp.define}: expected ${JSON.stringify(cmp.expected)}, got ${JSON.stringify(
              cmp.actual,
            )}${cmp.reason ? ` (${cmp.reason})` : ''}`,
          });
        }
      }
    }
  }

  return {
    ...taskReport,
    tiers: {
      t0_style: 'not-applicable',
      t1_parse: 'not-applicable',
      t2_type: 'not-applicable',
      t3_execute,
      t4_measure: 'not-applicable',
      t5_semantic: 'not-applicable',
    },
    diagnostics,
  };
}

export function aggregateRun(args: {
  startedAt: string;
  today: string;
  sourceRevision: string;
  tasks: TaskReport[];
}): RunReport {
  const cases = args.tasks.flatMap((t) => t.cases);
  const tasksPassed = args.tasks.filter((t) => t.tiers.t3_execute === 'pass').length;
  return {
    startedAt: args.startedAt,
    today: args.today,
    sourceRevision: args.sourceRevision,
    tasks: args.tasks,
    totals: {
      cases: cases.length,
      casesPassed: cases.filter((c) => c.passed).length,
      tasks: args.tasks.length,
      tasksPassed,
    },
  };
}

/** Write JSON report. Returns the path written. */
export function writeJsonReport(report: RunReport, path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(report, null, 2));
  return path;
}

/**
 * Write a JUnit-style XML report. Each (task, patient) is a `<testcase>`;
 * the task is the `classname`.
 */
export function writeJunitReport(report: RunReport, path: string): string {
  mkdirSync(dirname(path), { recursive: true });

  const totalCases = report.totals.cases;
  const failures = totalCases - report.totals.casesPassed;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    `<testsuite name="who-cql-agent-eval" tests="${totalCases}" failures="${failures}" timestamp="${report.startedAt}">`,
  );
  for (const task of report.tasks) {
    const cls = `${task.dak}.${task.table}`;
    for (const c of task.cases) {
      const name = escapeXml(`${task.logicLibraryId}/${c.patientId}`);
      lines.push(`  <testcase classname="${escapeXml(cls)}" name="${name}">`);
      if (!c.passed) {
        const msg = c.errors.length > 0 ? c.errors.join('; ') : 'expected/actual mismatch';
        lines.push(`    <failure message="${escapeXml(msg)}">`);
        for (const cmp of c.comparisons) {
          if (cmp.pass) continue;
          lines.push(escapeXml(`  ${cmp.define}: expected ${JSON.stringify(cmp.expected)}; got ${JSON.stringify(cmp.actual)}`));
        }
        lines.push('    </failure>');
      }
      lines.push('  </testcase>');
    }
  }
  lines.push('</testsuite>');
  writeFileSync(path, lines.join('\n'));
  return path;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '&':
        return '&amp;';
      case '"':
        return '&quot;';
      case "'":
        return '&apos;';
      default:
        return c;
    }
  });
}
