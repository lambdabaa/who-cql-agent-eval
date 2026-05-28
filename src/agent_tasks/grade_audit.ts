import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditFindingsFileSchema, type AuditFinding, type AuditTaskSpec } from './schema.js';

/**
 * Grade an audit submission.
 *
 * There is no truth file — audit just surfaces what each agent flagged.
 * The grader records the findings array verbatim, plus a few quick
 * statistics (count, severity distribution). Cross-agent consensus is
 * computed at the baseline-roll-up stage, not here.
 */

export interface GradeAuditOptions {
  spec: AuditTaskSpec;
  taskDir: string;
  reportPath: string;
}

export interface GradeAuditResult {
  taskId: string;
  agentSubmitted: boolean;
  findingsCount: number;
  findings: AuditFinding[];
  parseError?: string;
}

export function gradeAudit(opts: GradeAuditOptions): GradeAuditResult {
  const submission = join(opts.taskDir, 'outputs', 'findings.json');
  if (!existsSync(submission)) {
    return emptyResult(opts.spec, 'no submission');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(submission, 'utf8'));
  } catch (e) {
    return emptyResult(opts.spec, `findings.json not valid JSON: ${(e as Error).message}`);
  }
  const parsed = AuditFindingsFileSchema.safeParse(raw);
  if (!parsed.success) {
    return emptyResult(opts.spec, `findings.json fails schema: ${parsed.error.message}`);
  }
  const result: GradeAuditResult = {
    taskId: opts.spec.id,
    agentSubmitted: true,
    findingsCount: parsed.data.findings.length,
    findings: parsed.data.findings,
  };
  writeFileSync(opts.reportPath, JSON.stringify(result, null, 2) + '\n');
  return result;
}

function emptyResult(spec: AuditTaskSpec, reason: string): GradeAuditResult {
  return {
    taskId: spec.id,
    agentSubmitted: false,
    findingsCount: 0,
    findings: [],
    parseError: reason,
  };
}
