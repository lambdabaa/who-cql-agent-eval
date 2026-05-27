import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/**
 * Thin wrapper around the `cql-to-elm` translator jar from
 * `cqframework/clinical_quality_language` (org.cqframework.cql.cql2elm.cli.Main).
 *
 * The jar is not bundled with this repo. Build it with
 * `./scripts/fetch_cql_to_elm.sh` (requires Java + Maven). The script produces
 * a runnable fat jar at `tools/cql-to-elm/cql-to-elm.jar`; override the
 * location via `$CQL_TO_ELM_JAR`.
 *
 * Output ELM JSON is content-addressed by the SHA-256 of (jar bytes + every
 * .cql file in every search dir), so a rerun against an unchanged corpus on
 * the same jar is instant.
 *
 * CLI shape (from cql-to-elm-cli v3.26 Main):
 *   --input <file-or-dir>   CQL source (recursed when dir)
 *   --output <file-or-dir>  ELM destination (mirrors input shape)
 *   --format JSON|XML|COFFEE
 *
 * There is no `--library-path` flag; `include` resolution happens across all
 * .cql files under `--input` when the input is a directory. To pull in
 * cross-package dependencies (e.g. WHO smart-base) we copy/symlink their
 * .cql into a unified staging dir.
 */

export interface CompileOptions {
  /**
   * Directories containing .cql sources. All .cql files in all dirs are
   * compiled together so cross-dir `include`s resolve. The first dir is
   * canonical (its identifier is reported back in `result.libraries`).
   */
  sourceDirs: string[];
  /** Path to cql-to-elm jar. Defaults to env CQL_TO_ELM_JAR. */
  jarPath?: string;
  /** Output dir for ELM JSON. Defaults to `.cache/elm`. */
  outDir?: string;
  /** Pass-through translator options. */
  extraArgs?: string[];
}

export interface CompiledLibrary {
  /** Library identifier as declared in the CQL `library X` statement. */
  identifier: string;
  /** Path to the .cql source. */
  cqlPath: string;
  /** Path to the generated ELM JSON. */
  elmPath: string;
  /** Parsed ELM JSON. */
  elm: unknown;
}

export interface CompileResult {
  libraries: CompiledLibrary[];
  /** Source-file paths that failed to compile and the translator stderr. */
  errors: Array<{ cqlPath: string; stderr: string }>;
  cacheHits: number;
  cacheMisses: number;
}

/**
 * Compile every .cql file under every `sourceDirs` entry. The dirs are
 * staged into a single working dir so cross-dir `include`s resolve, then a
 * single translator invocation produces ELM for the whole set.
 */
export function compileCql(options: CompileOptions): CompileResult {
  const jarPath = options.jarPath ?? process.env.CQL_TO_ELM_JAR ?? defaultJarPath();
  if (!existsSync(jarPath)) {
    throw new Error(
      `cql-to-elm jar not found at ${jarPath}.\n` +
        `Set CQL_TO_ELM_JAR or run scripts/fetch_cql_to_elm.sh to build it.`,
    );
  }

  if (options.sourceDirs.length === 0) throw new Error('compileCql requires at least one source dir');

  const cqlFiles = options.sourceDirs.flatMap((d) => listCqlFiles(d));
  if (cqlFiles.length === 0) {
    return { libraries: [], errors: [], cacheHits: 0, cacheMisses: 0 };
  }

  const jarHash = sha256File(jarPath);
  // Cache key covers the jar + every input .cql byte. Cheap because the WHO
  // CQL corpus is ~tens of files.
  const corpusHash = sha256(
    `${jarHash}\n` + cqlFiles.map((p) => `${p}:${sha256(readFileSync(p, 'utf8'))}`).join('\n'),
  );

  const cacheRoot = options.outDir ?? join(process.cwd(), '.cache', 'elm');
  const stageDir = join(cacheRoot, corpusHash.slice(0, 12));
  const elmDir = join(stageDir, 'out');
  mkdirSync(elmDir, { recursive: true });
  const result: CompileResult = { libraries: [], errors: [], cacheHits: 0, cacheMisses: 0 };

  const cached = existsSync(stageDir) && readdirSync(elmDir).filter((f) => f.endsWith('.json')).length > 0;
  if (!cached) {
    const inputDir = join(stageDir, 'in');
    mkdirSync(inputDir, { recursive: true });
    for (const cqlPath of cqlFiles) {
      writeFileSync(join(inputDir, basename(cqlPath)), readFileSync(cqlPath));
    }
    // Stage bundled FHIRHelpers (it must land alongside the WHO .cql files
    // so the translator picks it up as a regular input). The translator's
    // built-in classpath finds FHIRHelpers on its own at compile time, but
    // it does not *emit* ELM for libraries it didn't see as inputs — so any
    // retrieve that goes through `FHIRHelpers.ToString(...)` etc. fails at
    // exec time with "Cannot read properties of undefined".
    extractBundledHelpers(jarPath, inputDir);
    try {
      runTranslator(jarPath, inputDir, elmDir, options.extraArgs ?? []);
      result.cacheMisses = cqlFiles.length;
    } catch (e) {
      result.errors.push({ cqlPath: '<batch>', stderr: (e as Error).message });
      return result;
    }
  } else {
    result.cacheHits = cqlFiles.length;
  }

  // Load every .json the translator produced — that's the canonical set the
  // executor needs at runtime. We pair each ELM back to its source .cql when
  // we can find it under sourceDirs, but bundled helpers staged inline
  // (FHIRHelpers, etc.) don't have an upstream cqlPath; they still need to
  // ride along so the Repository can resolve `include FHIRHelpers`.
  const cqlByStem = new Map<string, string>();
  for (const cqlPath of cqlFiles) cqlByStem.set(basename(cqlPath, '.cql'), cqlPath);
  const elmFiles = readdirSync(elmDir).filter((f) => f.endsWith('.json'));
  for (const f of elmFiles) {
    const elmPath = join(elmDir, f);
    const stem = basename(f, '.json');
    try {
      const elm = JSON.parse(readFileSync(elmPath, 'utf8'));
      const cqlPath = cqlByStem.get(stem) ?? join(stageDir, 'in', `${stem}.cql`);
      const cqlSource = existsSync(cqlPath) ? readFileSync(cqlPath, 'utf8') : '';
      result.libraries.push({
        identifier: extractLibraryIdentifier(cqlSource) ?? stem,
        cqlPath,
        elmPath,
        elm,
      });
    } catch (e) {
      result.errors.push({ cqlPath: elmPath, stderr: `corrupt ELM JSON: ${(e as Error).message}` });
    }
  }

  // Surface any source files the translator declined to emit ELM for.
  for (const cqlPath of cqlFiles) {
    const stem = basename(cqlPath, '.cql');
    if (!elmFiles.some((f) => f === `${stem}.json`)) {
      result.errors.push({ cqlPath, stderr: `translator did not emit ${stem}.json` });
    }
  }

  return result;
}

/**
 * Compile a single CQL string (typically agent output) using the same cache.
 * Returns the in-memory ELM, the on-disk path, or an error.
 */
export function compileCqlString(
  source: string,
  libraryName: string,
  options: CompileOptions,
): { elm?: unknown; elmPath?: string; error?: string } {
  const subjectDir = options.sourceDirs[0];
  if (!subjectDir) return { error: 'compileCqlString requires sourceDirs[0] as library search path' };
  const tmpDir = join(process.cwd(), '.cache', 'agent-cql');
  mkdirSync(tmpDir, { recursive: true });
  const cqlPath = join(tmpDir, `${libraryName}.cql`);
  writeFileSync(cqlPath, source);
  const result = compileCql({ ...options, sourceDirs: [tmpDir, ...options.sourceDirs] });
  const lib = result.libraries.find((l) => l.cqlPath === cqlPath);
  if (!lib) {
    const err = result.errors.find((e) => e.cqlPath === cqlPath);
    return { error: err?.stderr ?? 'translator produced no output' };
  }
  return { elm: lib.elm, elmPath: lib.elmPath };
}

/**
 * Pull `org/hl7/fhir/FHIRHelpers-<v>.cql` out of the translator jar into the
 * staging dir as `FHIRHelpers.cql`. Picks the highest available version so
 * downstream `include FHIRHelpers version '4.0.1'` resolves. Silent no-op if
 * the jar doesn't bundle a FHIRHelpers source.
 */
function extractBundledHelpers(jarPath: string, stageDir: string) {
  // Try the known FHIR R4 variants in preference order. We don't enumerate
  // the whole jar (its listing exceeds the default execFileSync buffer);
  // attempting a specific path is cheap and fails quickly when absent.
  const candidates = ['org/hl7/fhir/FHIRHelpers-4.0.1.cql', 'org/hl7/fhir/FHIRHelpers-4.0.0.cql'];
  for (const entry of candidates) {
    try {
      const cql = execFileSync('unzip', ['-p', jarPath, entry], {
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      });
      if (cql && cql.length > 0) {
        writeFileSync(join(stageDir, 'FHIRHelpers.cql'), cql);
        return;
      }
    } catch {
      // try next candidate
    }
  }
}

function runTranslator(jarPath: string, inputDir: string, outputDir: string, extraArgs: string[]) {
  // cql-to-elm-cli (org.cqframework.cql.cql2elm.cli.Main) jOpt-Simple flags:
  //   --input <file|dir>   CQL source (recursed when dir)
  //   --output <file|dir>  ELM destination (mirrors input)
  //   --format JSON|XML|COFFEE
  // No --library-path: includes are resolved among siblings of --input.
  const args = ['-jar', jarPath, '--input', resolve(inputDir), '--output', resolve(outputDir), '--format', 'JSON', ...extraArgs];
  try {
    execFileSync('java', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer; stdout?: Buffer; message: string };
    const stderr = (err.stderr?.toString() ?? '') + (err.stdout?.toString() ?? '') + err.message;
    throw new Error(stderr);
  }
}

function listCqlFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith('.cql')) out.push(p);
    }
  }
  walk(dir);
  return out.sort();
}

function extractLibraryIdentifier(source: string): string | undefined {
  const m = source.match(/^\s*library\s+([A-Za-z_][A-Za-z0-9_]*)/m);
  return m?.[1];
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function sha256File(path: string): string {
  return sha256(readFileSync(path).toString('base64'));
}

function defaultJarPath(): string {
  return join(process.cwd(), 'tools', 'cql-to-elm', 'cql-to-elm.jar');
}

export const DEFAULT_JAR_RELATIVE_PATH = 'tools/cql-to-elm/cql-to-elm.jar';
