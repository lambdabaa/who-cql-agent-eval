/**
 * Deterministic CQL mutators for C2 (cross-layer inconsistency detection).
 *
 * Each mutator takes a known-good CQL source and a seeded PRNG, scans for
 * candidate sites of one kind of bug, picks one site, and returns the
 * mutated source plus a Truth record describing exactly what changed. The
 * mutations are intentionally narrow and textually safe — they don't
 * rebalance parens, rename library identifiers, or alter `include`
 * statements. That keeps every variant cql-to-elm-parseable; the agent's
 * job is to spot the *semantic* bug, not catch a syntax error.
 *
 * v0 vocabulary (see MutationKindSchema):
 *   - boolean_op_flip    Flip `and` ↔ `or` at the start of a conjunct line.
 *   - reference_rename   Swap one `Encounter."X"` reference for a sibling
 *                        whose define exists in the same dep library.
 *   - precondition_drop  Remove one `and <conjunct>` line.
 *   - guidance_text_swap Swap one guidance string literal with another's.
 *   - comparator_flip    `is not null` ↔ `is null`, `!=` ↔ `=` in scalars.
 *
 * Out of scope for v0 — `threshold_change` (no numeric literals in Measles
 * Low Tx), and any mutation that requires whole-define restructuring.
 */

import type { MutationKind } from './schema.js';

export interface Mutation {
  kind: MutationKind;
  define: string;
  /** 1-based line in the mutated source (same as the original — mutations are in-place edits). */
  approxLine: number;
  original: string;
  modified: string;
}

export interface MutationResult {
  source: string;
  mutation: Mutation;
}

/** mulberry32 — small seeded PRNG, deterministic across runs. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, arr: T[]): T {
  if (arr.length === 0) throw new Error('pick from empty array');
  return arr[Math.floor(rng() * arr.length)]!;
}

/**
 * Walk back from `lineIdx` to the nearest `define "<name>":` line and return
 * the name. Returns 'unknown' if no enclosing define is found (only happens
 * in the file header).
 */
function enclosingDefine(lines: string[], lineIdx: number): string {
  for (let i = lineIdx; i >= 0; i -= 1) {
    const m = lines[i]!.match(/^\s*define\s+"([^"]+)"\s*:/);
    if (m) return m[1]!;
  }
  return 'unknown';
}

/**
 * Replace exactly one line in `source` at `lineIdx` (0-based) with
 * `newLine`. Returns the new source.
 */
function replaceLine(source: string, lineIdx: number, newLine: string): string {
  const lines = source.split('\n');
  lines[lineIdx] = newLine;
  return lines.join('\n');
}

function removeLine(source: string, lineIdx: number): string {
  const lines = source.split('\n');
  lines.splice(lineIdx, 1);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

/**
 * Flip `and` ↔ `or` at the start of a conjunct continuation line.
 * Candidate lines look like `    and Encounter."X"` or `    or "Y"`.
 */
export function mutateBooleanOpFlip(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s+(and|or)\s+/.test(lines[i]!)) candidates.push(i);
  }
  if (candidates.length === 0) throw new Error('boolean_op_flip: no candidates');
  const idx = pick(rng, candidates);
  const orig = lines[idx]!;
  const modified = orig.replace(/^(\s+)(and|or)(\s+)/, (_, sp1, op, sp2) =>
    `${sp1}${op === 'and' ? 'or' : 'and'}${sp2}`,
  );
  return {
    source: replaceLine(source, idx, modified),
    mutation: {
      kind: 'boolean_op_flip',
      define: enclosingDefine(lines, idx),
      approxLine: idx + 1,
      original: orig,
      modified,
    },
  };
}

/**
 * Swap one `Encounter."A"` reference for `Encounter."B"` where B is a
 * known sibling helper. Pairs are hand-picked to be valid identifiers in
 * IMMZD2DTMeaslesEncounterElements; the resulting library still compiles.
 */
const REFERENCE_SWAPS: Array<[string, string]> = [
  ["Client's age is less than 12 months", "Client's age is less than 15 months"],
  ["Client's age is more than or equal to 12 months", "Client's age is more than or equal to 15 months"],
  ['MCV1 was administered', 'MCV2 was administered'],
  ['Live vaccine was administered in the last 4 weeks', 'No live vaccine was administered in the last 4 weeks'],
];

export function mutateReferenceRename(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  type Site = { lineIdx: number; from: string; to: string };
  const sites: Site[] = [];
  for (const [a, b] of REFERENCE_SWAPS) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      // Only target Encounter."…" references, not the `\"X\" Guidance` aliases.
      if (line.includes(`Encounter."${a}"`)) sites.push({ lineIdx: i, from: a, to: b });
      if (line.includes(`Encounter."${b}"`)) sites.push({ lineIdx: i, from: b, to: a });
    }
  }
  if (sites.length === 0) throw new Error('reference_rename: no candidates');
  const site = pick(rng, sites);
  const orig = lines[site.lineIdx]!;
  const modified = orig.replace(`Encounter."${site.from}"`, `Encounter."${site.to}"`);
  return {
    source: replaceLine(source, site.lineIdx, modified),
    mutation: {
      kind: 'reference_rename',
      define: enclosingDefine(lines, site.lineIdx),
      approxLine: site.lineIdx + 1,
      original: orig,
      modified,
    },
  };
}

/**
 * Remove one continuation line of the form `    and X`. Never removes the
 * first clause of a multi-clause define (that would yield `\n    and Y`
 * after a `:`, which is a syntax error).
 */
export function mutatePreconditionDrop(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s+and\s+/.test(lines[i]!)) continue;
    // Require the previous non-blank line to also be a clause (not a `:` opener)
    // — otherwise we'd be dropping the only continuation.
    let prevIdx = i - 1;
    while (prevIdx >= 0 && lines[prevIdx]!.trim() === '') prevIdx -= 1;
    const prev = lines[prevIdx]!;
    if (/:\s*$/.test(prev)) continue; // first clause sits right after `define "…":`
    candidates.push(i);
  }
  if (candidates.length === 0) throw new Error('precondition_drop: no candidates');
  const idx = pick(rng, candidates);
  const orig = lines[idx]!;
  return {
    source: removeLine(source, idx),
    mutation: {
      kind: 'precondition_drop',
      define: enclosingDefine(lines, idx),
      approxLine: idx + 1,
      original: orig,
      modified: '<line removed>',
    },
  };
}

/**
 * Swap one `<X> Guidance` string literal with another `<Y> Guidance` literal
 * from elsewhere in the same library. Always picks distinct outputs so the
 * swap is observable.
 *
 * Detection sites are define bodies of the shape:
 *   define "<X> Guidance":
 *     '<single-quoted multi-line string>'
 *
 * Implementation: collect every fully-quoted guidance string (possibly
 * multi-line) keyed by its enclosing define. Swap two of them.
 */
export function mutateGuidanceTextSwap(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  type Block = { define: string; startLine: number; endLine: number; text: string };
  const blocks: Block[] = [];

  let i = 0;
  while (i < lines.length) {
    const defM = lines[i]!.match(/^define\s+"([^"]+)"\s*:/);
    if (defM && defM[1]!.endsWith(' Guidance')) {
      // Find the string literal on subsequent lines: starts with `'` and
      // ends with a line containing a closing `'`.
      let start = -1;
      for (let j = i + 1; j < Math.min(lines.length, i + 20); j += 1) {
        if (/^\s*'/.test(lines[j]!) && !/^\s*case\b/.test(lines[j]!)) {
          start = j;
          break;
        }
      }
      if (start !== -1) {
        let end = start;
        // The closing `'` is on the same line if it's single-line, else on
        // a later line. Detect by counting unescaped single quotes.
        while (end < lines.length) {
          const stripped = lines[end]!.replace(/\\'/g, '');
          const quoteCount = (stripped.match(/'/g) || []).length;
          if (end === start && quoteCount >= 2) break;
          if (end > start && quoteCount >= 1) break;
          end += 1;
        }
        if (end < lines.length) {
          blocks.push({
            define: defM[1]!,
            startLine: start,
            endLine: end,
            text: lines.slice(start, end + 1).join('\n'),
          });
        }
      }
    }
    i += 1;
  }

  if (blocks.length < 2) throw new Error('guidance_text_swap: need ≥2 guidance blocks');
  const a = pick(rng, blocks);
  let b = pick(rng, blocks);
  // Ensure distinct
  let safety = 10;
  while (b.define === a.define && safety > 0) {
    b = pick(rng, blocks);
    safety -= 1;
  }
  if (b.define === a.define) throw new Error('guidance_text_swap: could not pick distinct pair');

  // Replace block A's text with block B's text (re-indent if needed: blocks
  // have the same indentation style, so straight substitution is fine).
  const newLines = [...lines];
  // Splice block A out and insert B's text.
  const bText = b.text;
  const aLen = a.endLine - a.startLine + 1;
  newLines.splice(a.startLine, aLen, ...bText.split('\n'));
  // If B's block came after A and shifted, recompute B's coords.
  let bStart = b.startLine;
  let bEnd = b.endLine;
  if (b.startLine > a.endLine) {
    const delta = bText.split('\n').length - aLen;
    bStart += delta;
    bEnd += delta;
  }
  // Replace B's region with A's original text.
  const aText = a.text;
  const bLen = bEnd - bStart + 1;
  newLines.splice(bStart, bLen, ...aText.split('\n'));

  return {
    source: newLines.join('\n'),
    mutation: {
      kind: 'guidance_text_swap',
      define: a.define,
      approxLine: a.startLine + 1,
      original: `${a.define}: ${a.text.trim().slice(0, 80)}…`,
      modified: `${a.define}: ${b.text.trim().slice(0, 80)}…`,
    },
  };
}

/**
 * Flip `is not null` ↔ `is null` or `!=` ↔ `=` in a boolean position.
 * Targets `define "Has Guidance":` and similar scalar comparisons.
 */
export function mutateComparatorFlip(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  type Site = { lineIdx: number; from: RegExp; to: string };
  const sites: Site[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (/\bis not null\b/.test(line)) sites.push({ lineIdx: i, from: /\bis not null\b/, to: 'is null' });
    else if (/\bis null\b/.test(line)) sites.push({ lineIdx: i, from: /\bis null\b/, to: 'is not null' });
    if (/!=/.test(line)) sites.push({ lineIdx: i, from: /!=/, to: '=' });
  }
  if (sites.length === 0) throw new Error('comparator_flip: no candidates');
  const site = pick(rng, sites);
  const orig = lines[site.lineIdx]!;
  const modified = orig.replace(site.from, site.to);
  return {
    source: replaceLine(source, site.lineIdx, modified),
    mutation: {
      kind: 'comparator_flip',
      define: enclosingDefine(lines, site.lineIdx),
      approxLine: site.lineIdx + 1,
      original: orig,
      modified,
    },
  };
}

export const ALL_MUTATORS: Record<Exclude<MutationKind, 'none' | 'threshold_change'>, (s: string, r: () => number) => MutationResult> = {
  boolean_op_flip: mutateBooleanOpFlip,
  reference_rename: mutateReferenceRename,
  precondition_drop: mutatePreconditionDrop,
  guidance_text_swap: mutateGuidanceTextSwap,
  comparator_flip: mutateComparatorFlip,
};
