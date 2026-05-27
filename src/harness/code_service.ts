import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CodeService } from 'cql-execution';

/**
 * Build a cql-execution `CodeService` from a WHO DAK's FSH ValueSets.
 *
 * The harness needs ValueSets so that retrieves like
 *   `[Immunization: Concepts."Measles-containing vaccines"]`
 * resolve at Tier-3 execution. WHO ships ValueSets in FSH source form (not
 * yet expanded JSON), which is convenient for us — the expansion grammar is
 * narrow and we don't need to run SUSHI to extract the codes.
 *
 * Recognized FSH lines:
 *   `* insert AddWithExpand( $SYS, #CODE, [[Display]] )`
 *   `* insert AddWithExpandCanonical( IMMZ.Z, #DE9, [[Display]] )`
 *   `* $SYS#CODE`           (occasionally used in older WHO files)
 *
 * `$SYS` is resolved through the IG's `Aliases.fsh`. Local CodeSystem refs
 * (e.g. `IMMZ.Z`, `IMMZ.D`) are mapped to the WHO-conventional canonical
 * `http://smart.who.int/immunizations/CodeSystem/<ID>`.
 */

export interface ValueSetMap {
  [valueSetUrl: string]: {
    [version: string]: Array<{ code: string; system: string; version?: string }>;
  };
}

export interface BuildOptions {
  /** Path to the DAK input directory, e.g. `vendor/smart-immunizations/input`. */
  dakInputDir: string;
  /** Canonical base URL for the DAK's CodeSystems. Defaults to WHO convention. */
  codeSystemBase?: string;
  /** Restrict to a subset of value-set names (e.g. `['IMMZ.Z.DE9']`). */
  valueSetWhitelist?: string[];
}

const DEFAULT_CS_BASE = 'http://smart.who.int/immunizations/CodeSystem';

/**
 * Build a CodeService from a WHO DAK's FSH ValueSet sources. Returns a fully
 * constructed CodeService ready to pass into `new Executor(library, codeService, ...)`.
 */
export function buildCodeServiceFromFsh(options: BuildOptions): { service: CodeService; map: ValueSetMap } {
  const map = buildValueSetMap(options);
  return { service: new CodeService(map), map };
}

export function buildValueSetMap(options: BuildOptions): ValueSetMap {
  const aliases = loadAliases(join(options.dakInputDir, 'fsh', 'Aliases.fsh'));
  const csBase = options.codeSystemBase ?? DEFAULT_CS_BASE;
  const vsDir = join(options.dakInputDir, 'fsh', 'valuesets');
  const map: ValueSetMap = {};
  if (!existsSync(vsDir)) return map;

  for (const file of readdirSync(vsDir)) {
    if (!file.endsWith('.fsh')) continue;
    const text = readFileSync(join(vsDir, file), 'utf8');
    const parsed = parseValueSet(text, aliases, csBase);
    if (!parsed) continue;
    if (options.valueSetWhitelist && !options.valueSetWhitelist.includes(parsed.id)) continue;
    const url = `http://smart.who.int/immunizations/ValueSet/${parsed.id}`;
    map[url] = { '': parsed.codes };
  }
  return map;
}

interface ParsedValueSet {
  id: string;
  codes: Array<{ code: string; system: string }>;
}

function parseValueSet(text: string, aliases: Map<string, string>, csBase: string): ParsedValueSet | null {
  const idMatch = text.match(/^ValueSet:\s*(\S+)/m);
  if (!idMatch?.[1]) return null;
  const id = idMatch[1];
  const codes: Array<{ code: string; system: string }> = [];

  for (const m of text.matchAll(/AddWithExpand(?:Canonical)?\(\s*([A-Za-z0-9_.$]+)\s*,\s*#([^,)\s]+)/g)) {
    const sysRef = m[1]!;
    const code = m[2]!;
    const system = resolveSystem(sysRef, aliases, csBase);
    if (!system) continue;
    codes.push({ code, system });
  }
  // Also accept older shorthand: `* $SYS#CODE`.
  for (const m of text.matchAll(/^\s*\*\s+(\$[A-Za-z][A-Za-z0-9]*|[A-Za-z][A-Za-z0-9.]*)#([^\s]+)/gm)) {
    const sysRef = m[1]!;
    const code = m[2]!;
    const system = resolveSystem(sysRef, aliases, csBase);
    if (!system) continue;
    codes.push({ code, system });
  }
  return { id, codes };
}

function resolveSystem(sysRef: string, aliases: Map<string, string>, csBase: string): string | null {
  if (sysRef.startsWith('$')) {
    return aliases.get(sysRef) ?? null;
  }
  // Treat any identifier-like ref as a DAK-local CodeSystem (IMMZ.Z, IMMZ.D, etc.).
  return `${csBase}/${sysRef}`;
}

function loadAliases(aliasesPath: string): Map<string, string> {
  const m = new Map<string, string>();
  if (!existsSync(aliasesPath)) return m;
  const text = readFileSync(aliasesPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*Alias:\s*(\$[A-Za-z][A-Za-z0-9]*)\s*=\s*(\S+)/);
    if (match) m.set(match[1]!, match[2]!);
  }
  return m;
}
