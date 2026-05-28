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
  /**
   * The define that holds the injected bug. For swap mutators (e.g.
   * guidance_text_swap) that mutate two defines symmetrically, this is
   * the "primary" anchor define; see `definesAffected` for the full set.
   */
  define: string;
  /**
   * All defines whose body changed as a result of this mutation. For
   * single-site mutators this equals `[define]`. For swap mutators this
   * lists both endpoints — the grader treats any one as a correct
   * localization.
   */
  definesAffected: string[];
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
 * Compute, for each line, whether it lies *inside* a `/* … *​/` block
 * comment. The opening `/​*` line and the closing `*​/` line are flagged
 * too. Used to keep mutators from picking sites inside pseudocode
 * comments — those don't actually run, and `enclosingDefine` will
 * mis-attribute them to the *preceding* define rather than the one
 * the comment annotates.
 */
function computeCommentMask(lines: string[]): boolean[] {
  const inComment: boolean[] = new Array(lines.length).fill(false);
  let depth = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    // A line is "inside a comment" if depth>0 when we start it OR it opens one.
    if (depth > 0) inComment[i] = true;
    let j = 0;
    while (j < line.length - 1) {
      if (line[j] === '/' && line[j + 1] === '*') {
        depth += 1;
        inComment[i] = true;
        j += 2;
      } else if (line[j] === '*' && line[j + 1] === '/') {
        depth = Math.max(0, depth - 1);
        inComment[i] = true;
        j += 2;
      } else {
        j += 1;
      }
    }
  }
  return inComment;
}

function isLineCode(line: string, lineIdx: number, mask: boolean[]): boolean {
  if (mask[lineIdx]) return false;
  if (/^\s*\/\//.test(line)) return false;
  return true;
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
  const mask = computeCommentMask(lines);
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isLineCode(lines[i]!, i, mask)) continue;
    if (/^\s+(and|or)\s+/.test(lines[i]!)) candidates.push(i);
  }
  if (candidates.length === 0) throw new Error('boolean_op_flip: no candidates');
  const idx = pick(rng, candidates);
  const orig = lines[idx]!;
  const modified = orig.replace(/^(\s+)(and|or)(\s+)/, (_, sp1, op, sp2) =>
    `${sp1}${op === 'and' ? 'or' : 'and'}${sp2}`,
  );
  const def = enclosingDefine(lines, idx);
  return {
    source: replaceLine(source, idx, modified),
    mutation: {
      kind: 'boolean_op_flip',
      define: def,
      definesAffected: [def],
      approxLine: idx + 1,
      original: orig,
      modified,
    },
  };
}

/**
 * Helper-relation facts about WHO DAK libraries. These pairs hold across
 * Logic libraries that use the same helpers / choice sets / data elements.
 *
 * Pair entries are *fully-qualified* references — `Encounter."X"`, `Cx."Y"`,
 * etc. — so the same finder mechanism works across DAK conventions
 * (`smart-immunizations` uses `Encounter.` helpers; `smart-anc` uses
 * `Cx."<choice set>"` and `ContactData."<element>"`).
 *
 * `ENTITY_REFERENCE_PAIRS` — swaps that change the referenced *entity*
 * (MCV1 ↔ MCV2, "HIV negative" ↔ "HIV positive"). Numeric form preserved.
 *
 * `THRESHOLD_PAIRS` — swaps that keep the predicate type but change the
 * numeric threshold inside the reference name (e.g. "…less than 12 months"
 * → "…less than 15 months"). Distinct from entity swaps because the
 * *referent* type is the same; only the number is wrong.
 */
const ENTITY_REFERENCE_PAIRS: Array<[string, string]> = [
  // smart-immunizations: Measles Encounter helpers
  ['Encounter."MCV1 was administered"', 'Encounter."MCV2 was administered"'],
  ['Encounter."Live vaccine was administered in the last 4 weeks"', 'Encounter."No live vaccine was administered in the last 4 weeks"'],
  ['Encounter."Live vaccine was administered in the past 4 weeks"', 'Encounter."No live vaccine was administered in the past 4 weeks"'],
  ['Encounter."MCV0 was administered"', 'Encounter."MCV0 was not administered"'],
  ['Encounter."Measles supplementary dose was administered"', 'Encounter."Measles supplementary dose was not administered"'],
  // smart-anc: Cx choice sets
  ['Cx."HIV status - HIV negative Choices"', 'Cx."HIV status - HIV positive Choices"'],
];

const THRESHOLD_PAIRS: Array<[string, string]> = [
  // smart-immunizations: cross-table age thresholds.
  ['Encounter."Client\'s age is less than 6 months"', 'Encounter."Client\'s age is less than 9 months"'],
  ['Encounter."Client\'s age is less than 9 months"', 'Encounter."Client\'s age is less than 12 months"'],
  ['Encounter."Client\'s age is less than 12 months"', 'Encounter."Client\'s age is less than 15 months"'],
  ['Encounter."Client\'s age is more than or equal to 9 months"', 'Encounter."Client\'s age is more than or equal to 12 months"'],
  ['Encounter."Client\'s age is more than or equal to 12 months"', 'Encounter."Client\'s age is more than or equal to 15 months"'],
];

function findSwapSites(source: string, pairs: Array<[string, string]>): Array<{ lineIdx: number; from: string; to: string }> {
  const lines = source.split('\n');
  const mask = computeCommentMask(lines);
  const sites: Array<{ lineIdx: number; from: string; to: string }> = [];
  for (const [a, b] of pairs) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!isLineCode(line, i, mask)) continue;
      if (line.includes(a)) sites.push({ lineIdx: i, from: a, to: b });
      if (line.includes(b)) sites.push({ lineIdx: i, from: b, to: a });
    }
  }
  return sites;
}

export function mutateReferenceRename(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  const sites = findSwapSites(source, ENTITY_REFERENCE_PAIRS);
  if (sites.length === 0) throw new Error('reference_rename: no candidates');
  const site = pick(rng, sites);
  const orig = lines[site.lineIdx]!;
  const modified = orig.replace(site.from, site.to);
  const def = enclosingDefine(lines, site.lineIdx);
  return {
    source: replaceLine(source, site.lineIdx, modified),
    mutation: {
      kind: 'reference_rename',
      define: def,
      definesAffected: [def],
      approxLine: site.lineIdx + 1,
      original: orig,
      modified,
    },
  };
}

/**
 * Threshold change: in helper-driven libraries, swap a numeric-threshold
 * helper reference for another with the same predicate but a different
 * number (e.g. `"…less than 12 months"` → `"…less than 15 months"`). In
 * libraries with inline literals (smart-anc style), nudge an integer
 * literal followed by a unit string (e.g. `5 '%'` → `6 '%'`, `29 'weeks'`
 * → `30 'weeks'`). Both forms preserve syntactic validity; only the
 * clinical threshold is wrong.
 */
export function mutateThresholdChange(source: string, rng: () => number): MutationResult {
  // Prefer helper-name swaps when they exist (richer semantic signal).
  const helperSites = findSwapSites(source, THRESHOLD_PAIRS);
  if (helperSites.length > 0) {
    const lines = source.split('\n');
    const site = pick(rng, helperSites);
    const orig = lines[site.lineIdx]!;
    const modified = orig.replace(site.from, site.to);
    const def = enclosingDefine(lines, site.lineIdx);
    return {
      source: replaceLine(source, site.lineIdx, modified),
      mutation: {
        kind: 'threshold_change',
        define: def,
        definesAffected: [def],
        approxLine: site.lineIdx + 1,
        original: orig,
        modified,
      },
    };
  }
  // Fall back to inline-literal nudge: `<integer> '<unit>'`. Pick a site,
  // nudge by +1 (or -1 if the original is already 1, so we don't produce 0
  // and trigger semantic degeneracy).
  const lines = source.split('\n');
  const mask = computeCommentMask(lines);
  type InlineSite = { lineIdx: number; match: string; replacement: string };
  const inlineSites: InlineSite[] = [];
  const re = /\b(\d+)(\s*'[A-Za-z%]+')/g;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!isLineCode(line, i, mask)) continue;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const num = parseInt(m[1]!, 10);
      const delta = num <= 1 ? 1 : (num >= 100 ? -1 : 1);
      const newNum = num + delta;
      inlineSites.push({ lineIdx: i, match: m[0], replacement: `${newNum}${m[2]}` });
    }
  }
  if (inlineSites.length === 0) throw new Error('threshold_change: no candidates');
  const site = pick(rng, inlineSites);
  const orig = lines[site.lineIdx]!;
  const modified = orig.replace(site.match, site.replacement);
  const def = enclosingDefine(lines, site.lineIdx);
  return {
    source: replaceLine(source, site.lineIdx, modified),
    mutation: {
      kind: 'threshold_change',
      define: def,
      definesAffected: [def],
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
  const mask = computeCommentMask(lines);
  const candidates: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!isLineCode(lines[i]!, i, mask)) continue;
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
  const def = enclosingDefine(lines, idx);
  return {
    source: removeLine(source, idx),
    mutation: {
      kind: 'precondition_drop',
      define: def,
      definesAffected: [def],
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
      // Look for an immediate single-quoted literal (skipping only blank
      // lines). If the first non-blank line in the define body is a
      // `case`/expression/identifier instead, this define isn't a
      // simple-literal guidance block and we skip it. This prevents the
      // forward scan from grabbing the next define's literal.
      let start = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const line = lines[j]!;
        if (line.trim() === '') continue;
        if (/^\s*'/.test(line)) {
          start = j;
        }
        break;
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
      // Both endpoints of the swap mutate symmetrically — either is a valid
      // localization.
      definesAffected: [a.define, b.define],
      approxLine: a.startLine + 1,
      original: `${a.define}: ${a.text.trim().slice(0, 80)}…`,
      modified: `${a.define}: ${b.text.trim().slice(0, 80)}…`,
    },
  };
}

/**
 * Flip a comparator in a boolean position. Covers:
 *   - `is not null` ↔ `is null`
 *   - `!=` ↔ `=`  (and the plain `=` ↔ `!=` direction for inline equalities)
 *   - `>=` ↔ `>` and `<=` ↔ `<` (boundary tweaks on numeric comparators)
 *   - `<` ↔ `<=` and `>` ↔ `>=` (the same boundary tweaks, opposite side)
 *
 * Lookbehinds disambiguate `=` from `!=`, `>=`, `<=` so each operator is
 * counted exactly once per occurrence. Comment lines (`//`, `/*`) are
 * skipped so we never mutate a pseudocode annotation.
 */
const COMPARATOR_FLIPS: Array<{ pattern: RegExp; to: string }> = [
  { pattern: /\bis not null\b/g, to: 'is null' },
  { pattern: /\bis null\b/g, to: 'is not null' },
  { pattern: /!=/g, to: '=' },
  { pattern: />=/g, to: '>' },
  { pattern: /<=/g, to: '<' },
  { pattern: /(?<![!<>])=(?!=)/g, to: '!=' },
  { pattern: /(?<![<])<(?![=])/g, to: '<=' },
  { pattern: /(?<![>])>(?![=])/g, to: '>=' },
];

export function mutateComparatorFlip(source: string, rng: () => number): MutationResult {
  const lines = source.split('\n');
  const mask = computeCommentMask(lines);
  type Site = { lineIdx: number; matchedText: string; to: string; matchIndex: number };
  const sites: Site[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!isLineCode(line, i, mask)) continue;
    for (const { pattern, to } of COMPARATOR_FLIPS) {
      pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = pattern.exec(line)) !== null) {
        sites.push({ lineIdx: i, matchedText: m[0], to, matchIndex: m.index });
      }
    }
  }
  if (sites.length === 0) throw new Error('comparator_flip: no candidates');
  const site = pick(rng, sites);
  const orig = lines[site.lineIdx]!;
  // Replace at the exact character position so multiple matches on the same
  // line don't all flip.
  const modified = orig.slice(0, site.matchIndex) + site.to + orig.slice(site.matchIndex + site.matchedText.length);
  const def = enclosingDefine(lines, site.lineIdx);
  return {
    source: replaceLine(source, site.lineIdx, modified),
    mutation: {
      kind: 'comparator_flip',
      define: def,
      definesAffected: [def],
      approxLine: site.lineIdx + 1,
      original: orig,
      modified,
    },
  };
}

export const ALL_MUTATORS: Record<Exclude<MutationKind, 'none'>, (s: string, r: () => number) => MutationResult> = {
  boolean_op_flip: mutateBooleanOpFlip,
  reference_rename: mutateReferenceRename,
  precondition_drop: mutatePreconditionDrop,
  guidance_text_swap: mutateGuidanceTextSwap,
  comparator_flip: mutateComparatorFlip,
  threshold_change: mutateThresholdChange,
};
