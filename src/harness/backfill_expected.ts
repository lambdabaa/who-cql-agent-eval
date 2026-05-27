import { readFileSync } from 'node:fs';

/**
 * Scrape WHO's existing test artifacts for human-authored expected outputs
 * and emit draft `expected:` YAML blocks. Always written out for human
 * review — never auto-applied — because the source signals (free-text
 * comments + a `Test Validation` CQL case-statement) are best-effort.
 *
 * Two sources are recognized:
 *
 *   1. YAML comments. Lines beginning with `### ` inside a YAML doc are
 *      conventionally the row's expected outcome (e.g. `### Client is due
 *      for MCV1`). One per CQL define name; the harness checks for
 *      `<comment> = true` against the library's defines.
 *   2. The `Test Validation` define inside the Logic library, which is a
 *      `case when Patient.id = '...' then "<define>" and "Guidance" = '...'`
 *      structure. The `when` clauses are the patient ids; the predicates
 *      give defines that should be truthy plus literal Guidance strings.
 */

export interface BackfillCase {
  patientId: string;
  /** Defines mentioned in the source signal, with the expected value. */
  defines: Record<string, unknown>;
  /** Free-text notes captured from `### ` lines, for the human reviewer. */
  notes: string[];
  /** Origin of each define ('comment' | 'test-validation'). */
  sources: Record<string, 'comment' | 'test-validation'>;
}

/**
 * Backfill from an `examples.yaml` (multi-doc) file alone.
 *
 * Each `---`-separated doc is scanned for `### ` comment lines that match
 * known define names. We don't parse the YAML itself — we tokenize against
 * doc separators and `id:` lines so we don't fight YAML's quoting rules.
 */
export function backfillFromYaml(yamlText: string, knownDefines: string[]): BackfillCase[] {
  const cases: BackfillCase[] = [];
  const docs = yamlText.split(/^---\s*$/m);
  const defineSet = new Set(knownDefines);

  for (const doc of docs) {
    const idMatch = doc.match(/^id:\s*(\S+)/m);
    if (!idMatch?.[1]) continue;
    const patientId = idMatch[1];
    const notes: string[] = [];
    const defines: Record<string, unknown> = {};
    const sources: Record<string, 'comment' | 'test-validation'> = {};

    for (const line of doc.split(/\r?\n/)) {
      const m = line.match(/^###\s+(.*)$/);
      if (!m?.[1]) continue;
      const text = m[1].trim();
      notes.push(text);
      if (defineSet.has(text)) {
        defines[text] = true;
        sources[text] = 'comment';
      }
    }
    cases.push({ patientId, defines, notes, sources });
  }

  return cases;
}

/**
 * Backfill from a Logic library's `Test Validation` define.
 *
 * The shape WHO authors is consistent:
 *
 *   define "Test Validation":
 *     case
 *       when Patient.id = 'Measles23.3' then "Client is due for MCV1" and "Guidance" = '...'
 *       when Patient.id = 'Measles22.1' then "Client is not due for MCV1 Case 1" and "Guidance" = '...'
 *       ...
 *     end
 *
 * We extract one define-name per `when` clause plus the literal `Guidance`
 * string when present. Quote escaping is preserved verbatim.
 */
export function backfillFromTestValidation(cqlSource: string): BackfillCase[] {
  const cases: BackfillCase[] = [];
  const block = cqlSource.match(/define\s+"Test Validation"\s*:\s*case([\s\S]*?)\bend\b/);
  if (!block?.[1]) return cases;
  const body = block[1];
  // Each `when` clause may span multiple lines; split on the keyword.
  const clauses = body.split(/\bwhen\b/).slice(1);
  for (const clause of clauses) {
    const idMatch = clause.match(/Patient\.id\s*=\s*'([^']+)'/);
    if (!idMatch?.[1]) continue;
    const patientId = idMatch[1];
    const defines: Record<string, unknown> = {};
    const sources: Record<string, 'comment' | 'test-validation'> = {};

    // Collect "<DefineName>" predicates that are conjoined positively.
    for (const m of clause.matchAll(/"([^"]+)"(?!\s*=)/g)) {
      const name = m[1]!;
      if (name === 'Guidance') continue;
      defines[name] = true;
      sources[name] = 'test-validation';
    }
    // Capture the literal Guidance string. CQL string literals delimit with
    // single quotes; escape via either `''` (CQL canonical) or `\'` (WHO's
    // de-facto convention). Allow both.
    const guidance = clause.match(/"Guidance"\s*=\s*'((?:[^'\\]|\\.|'')*)'/);
    if (guidance?.[1] !== undefined) {
      defines['Guidance'] = unescapeCqlString(guidance[1]);
      sources['Guidance'] = 'test-validation';
    }

    cases.push({ patientId, defines, notes: [], sources });
  }
  return cases;
}

/**
 * Merge YAML-derived and Test-Validation-derived backfills by patientId.
 * Test-Validation wins on define overlap (it's the more authoritative source).
 */
export function mergeBackfills(...sources: BackfillCase[][]): BackfillCase[] {
  const byId = new Map<string, BackfillCase>();
  for (const list of sources) {
    for (const c of list) {
      const cur = byId.get(c.patientId);
      if (!cur) {
        byId.set(c.patientId, { ...c });
        continue;
      }
      const merged: BackfillCase = {
        patientId: c.patientId,
        defines: { ...cur.defines, ...c.defines },
        notes: [...cur.notes, ...c.notes],
        sources: { ...cur.sources, ...c.sources },
      };
      byId.set(c.patientId, merged);
    }
  }
  return [...byId.values()];
}

/**
 * Render a single case as an `expected:` YAML block. Output is intentionally
 * minimal — a reviewer adds row labels / today overrides / regex matchers
 * before merging.
 */
export function renderExpectedBlock(c: BackfillCase): string {
  const lines: string[] = ['expected:'];
  if (c.notes.length > 0) {
    for (const n of c.notes) lines.push(`  # ${n}`);
  }
  lines.push('  defines:');
  for (const [k, v] of Object.entries(c.defines)) {
    if (typeof v === 'string' && (v.includes('\n') || v.includes("'") || v.includes('"'))) {
      // Use folded block scalar for multiline / quote-heavy strings.
      lines.push(`    ${JSON.stringify(k)}:`);
      lines.push(`      equals: ${JSON.stringify(v)}`);
    } else {
      lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

export function backfillFromPaths(yamlPath: string, cqlPath: string, knownDefines: string[]): BackfillCase[] {
  const yamlText = readFileSync(yamlPath, 'utf8');
  const cqlText = readFileSync(cqlPath, 'utf8');
  const fromYaml = backfillFromYaml(yamlText, knownDefines);
  const fromCql = backfillFromTestValidation(cqlText);
  return mergeBackfills(fromYaml, fromCql);
}

function unescapeCqlString(s: string): string {
  // CQL string literals double single quotes and allow embedded newlines.
  return s.replace(/\\'/g, "'").replace(/''/g, "'");
}
