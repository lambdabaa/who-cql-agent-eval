#!/usr/bin/env tsx
/**
 * Sanitize a baseline summary.json and emit it into docs/data/ for the
 * GitHub Pages leaderboard. Also copies the raw per-task model outputs
 * into docs/data/raw/<agent>/<task>/ so the leaderboard can show
 * qualitative model output and refreshes docs/data/manifest.json.
 *
 *   tsx scripts/build_leaderboard.ts            # latest baseline
 *   tsx scripts/build_leaderboard.ts 2026-05-28 # specific baseline date
 */
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinesDir = join(repoRoot, 'baselines');
const outDir = join(repoRoot, 'docs', 'data');
mkdirSync(outDir, { recursive: true });

function listBaselineDates(): string[] {
  return readdirSync(baselinesDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .filter((name) => {
      try {
        return statSync(join(baselinesDir, name, 'summary.json')).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    // Strip absolute filesystem paths up to the repo root so leaderboard
    // payloads don't leak local usernames.
    return value.split(repoRoot).join('').replace(/\/Users\/[^/]+\//g, '~/');
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v);
    return out;
  }
  return value;
}

const dates = listBaselineDates();
if (dates.length === 0) {
  console.error('No baseline directories found under', baselinesDir);
  process.exit(1);
}

const targetDate = process.argv[2] ?? dates[dates.length - 1];
if (!dates.includes(targetDate)) {
  console.error(`Baseline ${targetDate} not found. Available: ${dates.join(', ')}`);
  process.exit(1);
}

const source = JSON.parse(readFileSync(join(baselinesDir, targetDate, 'summary.json'), 'utf8'));
const sanitized = sanitize(source);
const outFile = join(outDir, `${targetDate}.json`);
writeFileSync(outFile, JSON.stringify(sanitized, null, 2));
console.log(`Wrote ${outFile}`);

// Copy raw per-task outputs (CQL files, detections.json, predictions.json,
// findings.json …) into docs/data/raw/<agent>/<task>/ so the leaderboard
// can lazy-load and render the qualitative output.
const runsDir = join(repoRoot, 'runs');
const rawRoot = join(outDir, 'raw');
rmSync(rawRoot, { recursive: true, force: true });
const rawIndex: Record<string, Record<string, string[]>> = {};

interface Row {
  agentId: string;
  taskId: string;
}
for (const row of source.rows as Row[]) {
  const src = join(runsDir, row.agentId, row.taskId, 'outputs');
  if (!existsSync(src)) continue;
  const files = readdirSync(src).filter((f) => statSync(join(src, f)).isFile());
  if (files.length === 0) continue;
  const dest = join(rawRoot, row.agentId, row.taskId);
  mkdirSync(dest, { recursive: true });
  for (const file of files) copyFileSync(join(src, file), join(dest, file));
  if (!rawIndex[row.agentId]) rawIndex[row.agentId] = {};
  rawIndex[row.agentId][row.taskId] = files;
}
writeFileSync(join(outDir, `${targetDate}.raw-index.json`), JSON.stringify(rawIndex, null, 2));
console.log(`Wrote ${join(outDir, `${targetDate}.raw-index.json`)} (${Object.keys(rawIndex).length} agents)`);

const manifest = {
  generatedAt: new Date().toISOString(),
  baselines: dates.map((d) => ({
    date: d,
    file: `${d}.json`,
    rawIndex: `${d}.raw-index.json`,
  })),
  latest: dates[dates.length - 1],
};
writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Wrote ${join(outDir, 'manifest.json')}`);
