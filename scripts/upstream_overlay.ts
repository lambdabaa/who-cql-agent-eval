#!/usr/bin/env tsx
/**
 * Apply our local `expected:` blocks to an upstream WHO test YAML.
 *
 * Inputs:
 *   --source <path>   Our overlay YAML (multi-doc, each with an `expected:` block).
 *                     Defaults to tests/dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml.
 *   --target <path>   The upstream YAML to patch (mutated in place).
 *
 * Behaviour:
 *   - Reads the source as raw text. For every doc that carries an `expected:`
 *     block, captures `id: <X>` and the verbatim slice from `expected:` to
 *     the next `---` or EOF.
 *   - Reads the target as raw text, splits into docs. For each doc whose
 *     `id:` matches the source map, appends the captured `expected:` slice
 *     at the end of that doc (immediately before the next `---` or EOF).
 *   - Idempotent: docs that already have an `expected:` block are left alone.
 *   - Preserves every other byte of the target — no reflow, no comment churn.
 *
 * Why text, not yaml.stringify: WHO's upstream YAML has hand-curated comments
 * (`###` outcomes, plain `#` preconditions) that any YAML library would drop
 * or relocate. The diff we want is purely additive — the `expected:` block
 * appears, nothing else moves.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

interface ParsedDoc {
  raw: string;
  id: string | undefined;
  expectedSlice: string | undefined;
  hasExpected: boolean;
}

const args = parseArgs({
  options: {
    source: { type: 'string', default: 'tests/dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml' },
    target: { type: 'string' },
    dryRun: { type: 'boolean', default: false },
  },
});

const sourcePath = args.values.source!;
const targetPath = args.values.target;
if (!targetPath) {
  console.error('--target <path> required');
  process.exit(2);
}

const source = readFileSync(sourcePath, 'utf8');
const target = readFileSync(targetPath, 'utf8');

const sourceDocs = splitDocs(source).map(parseDoc);
const expectedById = new Map<string, string>();
for (const d of sourceDocs) {
  if (d.id && d.expectedSlice) expectedById.set(d.id, d.expectedSlice);
}
if (expectedById.size === 0) {
  console.error(`source ${sourcePath} has no expected: blocks`);
  process.exit(1);
}

const targetSegments = splitDocs(target);
let patched = 0;
let skipped = 0;
for (let i = 0; i < targetSegments.length; i += 1) {
  const seg = targetSegments[i]!;
  const parsed = parseDoc(seg);
  if (!parsed.id) continue;
  if (parsed.hasExpected) {
    skipped += 1;
    continue;
  }
  const block = expectedById.get(parsed.id);
  if (!block) continue;
  targetSegments[i] = appendExpected(seg, block);
  patched += 1;
}

let out = joinDocs(targetSegments);
// Preserve the upstream's trailing newline (POSIX-friendly files).
if (target.endsWith('\n') && !out.endsWith('\n')) out += '\n';
if (args.values.dryRun) {
  process.stdout.write(out);
} else {
  writeFileSync(targetPath, out);
}

console.error(`patched ${patched} doc(s), skipped ${skipped} already-augmented, wrote ${targetPath}`);

// ---------------------------------------------------------------------------

function splitDocs(text: string): string[] {
  // Multi-doc YAML uses `\n---\n` between docs and may begin with `---\n`.
  // Preserve a leading separator as an empty first segment so joinDocs can
  // reconstitute it without inventing a blank line at BOF.
  let body = text;
  let hadLeading = false;
  if (body.startsWith('---\n')) {
    body = body.slice(4);
    hadLeading = true;
  }
  const parts = body.split(/\n---\n/);
  return hadLeading ? ['', ...parts] : parts;
}

function joinDocs(segments: string[]): string {
  if (segments[0] === '') return '---\n' + segments.slice(1).join('\n---\n');
  return segments.join('\n---\n');
}

function parseDoc(segment: string): ParsedDoc {
  const idMatch = segment.match(/^id:\s*(\S+)\s*$/m);
  const id = idMatch?.[1];
  // Capture `expected:` at column 0 through end-of-segment.
  const expectedMatch = segment.match(/^expected:[\s\S]*$/m);
  return {
    raw: segment,
    id,
    expectedSlice: expectedMatch?.[0],
    hasExpected: expectedMatch !== null,
  };
}

function appendExpected(segment: string, expectedSlice: string): string {
  // Strip trailing whitespace from both pieces so the joiner re-adds exactly
  // one `\n---\n` between docs (no inserted blank line). The very last
  // segment in a file usually retains its trailing `\n`; we restore that
  // afterwards in the join layer if applicable.
  const trimmedSeg = segment.replace(/\s+$/, '');
  const trimmedExp = expectedSlice.replace(/\s+$/, '');
  return `${trimmedSeg}\n${trimmedExp}`;
}
