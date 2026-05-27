import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Thin wrapper around the `cql-to-elm` translator jar from
 * `cqframework/clinical_quality_language`.
 *
 * The jar is not bundled with this repo (license-clean, but large). Drop it at
 * `tools/cql-to-elm/cql-to-elm.jar` or pass `jarPath` directly. The accompanying
 * `scripts/fetch_cql_to_elm.sh` script downloads a pinned release.
 *
 * Output ELM JSON is content-addressed: a (cql source SHA-256) + (jar SHA-256)
 * tuple keys the cache, so a rerun against unchanged source on the same jar
 * is instant.
 */

export interface CompileOptions {
  /**
   * Directories containing .cql sources. The first dir is the "subject" — its
   * .cql files are compiled. Subsequent dirs are library search paths (used for
   * resolving `include` references — e.g. WHO smart-base).
   */
  sourceDirs: string[];
  /** Path to cql-to-elm jar. Defaults to env CQL_TO_ELM_JAR. */
  jarPath?: string;
  /** Output dir for ELM JSON. Defaults to `.cache/elm`. */
  outDir?: string;
  /** Pass-through translator options (`--format=JSON`, etc.). */
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
 * Compile every .cql file under `sourceDirs[0]` (recursively). Library
 * dependencies are resolved by passing every `sourceDirs` entry on the
 * translator's `-mp` (model path) flag.
 */
export function compileCql(options: CompileOptions): CompileResult {
  const jarPath = options.jarPath ?? process.env.CQL_TO_ELM_JAR ?? defaultJarPath();
  if (!existsSync(jarPath)) {
    throw new Error(
      `cql-to-elm jar not found at ${jarPath}.\n` +
        `Set CQL_TO_ELM_JAR or run scripts/fetch_cql_to_elm.sh to download it.`,
    );
  }

  const outDir = options.outDir ?? join(process.cwd(), '.cache', 'elm');
  mkdirSync(outDir, { recursive: true });

  const subjectDir = options.sourceDirs[0];
  if (!subjectDir) throw new Error('compileCql requires at least one source dir');
  const cqlFiles = listCqlFiles(subjectDir);

  const jarHash = sha256File(jarPath);
  const result: CompileResult = { libraries: [], errors: [], cacheHits: 0, cacheMisses: 0 };

  for (const cqlPath of cqlFiles) {
    const cqlSource = readFileSync(cqlPath, 'utf8');
    const key = sha256(`${jarHash}\n${cqlSource}`);
    const elmPath = join(outDir, `${basename(cqlPath, '.cql')}.${key.slice(0, 12)}.elm.json`);

    if (existsSync(elmPath)) {
      try {
        const elm = JSON.parse(readFileSync(elmPath, 'utf8'));
        result.libraries.push({
          identifier: extractLibraryIdentifier(cqlSource) ?? basename(cqlPath, '.cql'),
          cqlPath,
          elmPath,
          elm,
        });
        result.cacheHits++;
        continue;
      } catch {
        // fall through to recompile if cache file is corrupt
      }
    }

    try {
      runTranslator(jarPath, cqlPath, options.sourceDirs, elmPath, options.extraArgs ?? []);
      const elm = JSON.parse(readFileSync(elmPath, 'utf8'));
      result.libraries.push({
        identifier: extractLibraryIdentifier(cqlSource) ?? basename(cqlPath, '.cql'),
        cqlPath,
        elmPath,
        elm,
      });
      result.cacheMisses++;
    } catch (e) {
      result.errors.push({ cqlPath, stderr: (e as Error).message });
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

function runTranslator(
  jarPath: string,
  cqlPath: string,
  searchDirs: string[],
  outPath: string,
  extraArgs: string[],
) {
  // The standalone cql-to-elm CLI flags:
  //   --input / -i  CQL source (file or dir)
  //   --output / -o output (file or dir)
  //   --model-info  …
  //   --format JSON|XML
  //   --library-path / -lp library search path
  const args = [
    '-jar',
    jarPath,
    '--input',
    cqlPath,
    '--output',
    outPath,
    '--format=JSON',
    ...searchDirs.flatMap((d) => ['--library-path', resolve(d)]),
    ...extraArgs,
  ];
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

// re-export for the fetch script to read
export const DEFAULT_JAR_RELATIVE_PATH = 'tools/cql-to-elm/cql-to-elm.jar';
// avoid an unused dirname import warning while keeping the import grouped
void dirname;
