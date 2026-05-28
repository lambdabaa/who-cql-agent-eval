import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { TaskSpec } from '../agent_tasks/schema.js';

/**
 * Shared file-system handoff conventions used by every AgentRunner.
 *
 * Input encoding
 * --------------
 * The runner builds one user message that concatenates:
 *   1. the prompt.md as-is (natural-language brief),
 *   2. an INPUTS section listing each file under `inputs/` with its content
 *      inside a fenced block tagged by relative path.
 *
 * Output encoding
 * ---------------
 * The model is instructed to emit each output file (named in
 * `task.outputFiles`) inside a fenced block whose info string starts with the
 * relative path, like:
 *
 *     ```path=IMMZD2DTMeaslesLowTransmissionLogic.cql
 *     library IMMZD2DTMeaslesLowTransmissionLogic
 *     ...
 *     ```
 *
 * `extractOutputFiles` parses these fenced blocks back out and writes each to
 * `outputs/<path>`. Missing files surface as warnings on `AgentRunResult`;
 * graders decide whether that is fatal.
 *
 * Why fenced blocks and not tool-use? v0's minimal contract is one model
 * round-trip per task. Tool-use would let the agent iterate, but it changes
 * the comparison (multi-turn agent vs single-turn) and isn't necessary for
 * A1/C4. We keep this surface for the next phase.
 */

const SYSTEM_TEMPLATE = `You are an expert in HL7 Clinical Quality Language (CQL) and WHO SMART Guidelines.
You will be given a task that produces files. For every file listed in OUTPUT FILES,
emit a fenced code block whose info string starts with \`path=<relative-path>\`,
e.g.:

    \`\`\`path=IMMZD2DTMeaslesLowTransmissionLogic.cql
    library IMMZD2DTMeaslesLowTransmissionLogic
    ...
    \`\`\`

Do not emit any other fenced blocks. Do not wrap files in extra commentary
between blocks unless the task asks you to. Match the exact file names the
task requires.`;

export interface ComposedPrompt {
  system: string;
  user: string;
}

export function composePrompt(taskDir: string, spec: TaskSpec): ComposedPrompt {
  const promptText = readFileSync(join(taskDir, 'prompt.md'), 'utf8');
  const inputsDir = join(taskDir, 'inputs');
  const inputFiles = listFilesRecursively(inputsDir).sort();

  const parts: string[] = [];
  parts.push(promptText.trim());
  parts.push('');
  parts.push('## OUTPUT FILES');
  parts.push('');
  parts.push('Emit exactly these files using `path=<name>` fenced blocks:');
  parts.push('');
  for (const f of spec.outputFiles) parts.push(`- \`${f}\``);
  parts.push('');

  if (inputFiles.length > 0) {
    parts.push('## INPUTS');
    parts.push('');
    for (const abs of inputFiles) {
      const rel = relative(inputsDir, abs);
      const ext = rel.split('.').pop() ?? '';
      const text = readFileSync(abs, 'utf8');
      parts.push(`### \`inputs/${rel}\``);
      parts.push('');
      parts.push('```' + ext);
      parts.push(text.replace(/\s+$/, ''));
      parts.push('```');
      parts.push('');
    }
  }

  return { system: SYSTEM_TEMPLATE, user: parts.join('\n') };
}

/**
 * Parse `path=...` fenced blocks out of the model response. Returns a map of
 * relative path → content. The opening fence may be tagged as
 * `path=foo.cql`, `cql path=foo.cql`, or any info string containing
 * `path=<token>` (token = non-whitespace).
 *
 * Fallback for single-output tasks: if no `path=` tagged blocks are found
 * AND the caller passes `expectedFiles` of length 1 AND there's at least
 * one fenced block whose info string matches the expected file's extension
 * (or is bare), treat the *last* such block as the file. Many small models
 * emit valid output inside a plain `\`\`\`json` block; rejecting them on a
 * missing tag throws away the actual answer.
 */
export function parseFencedOutputs(response: string, expectedFiles?: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /```[^\n]*?path=([^\s`]+)[^\n]*\n([\s\S]*?)```/g;
  for (const m of response.matchAll(re)) {
    const path = m[1];
    const body = m[2];
    if (path === undefined || body === undefined) continue;
    out[path] = body.replace(/\n$/, '');
  }
  if (Object.keys(out).length > 0) return out;

  if (expectedFiles && expectedFiles.length === 1) {
    const target = expectedFiles[0]!;
    const ext = target.split('.').pop() ?? '';
    const fallbackRe = /```([^\n]*)\n([\s\S]*?)```/g;
    let lastBody: string | undefined;
    for (const m of response.matchAll(fallbackRe)) {
      const info = (m[1] ?? '').trim();
      const body = m[2];
      if (body === undefined) continue;
      // Skip blocks that explicitly tag a different file via path=.
      if (info.includes('path=')) continue;
      // Accept bare-info or info matching the extension.
      if (info === '' || info === ext || info.startsWith(ext + ' ') || info.endsWith(' ' + ext)) {
        lastBody = body.replace(/\n$/, '');
      }
    }
    if (lastBody !== undefined) out[target] = lastBody;
  }
  return out;
}

export function writeOutputs(taskDir: string, files: Record<string, string>, expected: string[]): {
  written: string[];
  missing: string[];
} {
  const outDir = join(taskDir, 'outputs');
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  for (const [path, body] of Object.entries(files)) {
    const dest = join(outDir, path);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, body);
    written.push(path);
  }
  const missing = expected.filter((f) => !(f in files));
  return { written, missing };
}

function listFilesRecursively(dir: string): string[] {
  const out: string[] = [];
  try {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...listFilesRecursively(p));
      else out.push(p);
    }
  } catch {
    // missing inputs/ is fine; some tasks may have prompt-only inputs
  }
  return out;
}
