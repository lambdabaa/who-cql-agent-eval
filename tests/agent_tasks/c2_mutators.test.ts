import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mutateBooleanOpFlip,
  mutateReferenceRename,
  mutatePreconditionDrop,
  mutateGuidanceTextSwap,
  mutateComparatorFlip,
  mutateThresholdChange,
  seededRng,
} from '../../src/agent_tasks/c2_mutators.js';

const CQL_PATH = join(
  process.cwd(),
  'vendor/smart-immunizations/input/cql/IMMZD2DTMeaslesLowTransmissionLogic.cql',
);
const SOURCE = readFileSync(CQL_PATH, 'utf8');

describe('c2_mutators', () => {
  it('seededRng is deterministic', () => {
    const a = seededRng(42)();
    const b = seededRng(42)();
    expect(a).toBe(b);
    expect(seededRng(43)()).not.toBe(a);
  });

  it('boolean_op_flip changes exactly one and↔or token', () => {
    const r = mutateBooleanOpFlip(SOURCE, seededRng(1));
    expect(r.source).not.toBe(SOURCE);
    expect(r.mutation.kind).toBe('boolean_op_flip');
    // One-line edit
    const before = SOURCE.split('\n');
    const after = r.source.split('\n');
    expect(after.length).toBe(before.length);
    const diffs = before.map((l, i) => l !== after[i]).filter(Boolean).length;
    expect(diffs).toBe(1);
    expect(/^(\s+)(and|or)(\s+)/.test(r.mutation.original)).toBe(true);
    expect(/^(\s+)(and|or)(\s+)/.test(r.mutation.modified)).toBe(true);
    // The op actually flipped.
    const opOf = (s: string) => s.match(/^\s+(and|or)\s+/)?.[1];
    expect(opOf(r.mutation.original)).not.toBe(opOf(r.mutation.modified));
  });

  it('reference_rename swaps an entity helper (MCV1↔MCV2 etc.)', () => {
    const r = mutateReferenceRename(SOURCE, seededRng(2));
    expect(r.source).not.toBe(SOURCE);
    expect(r.mutation.kind).toBe('reference_rename');
    expect(r.mutation.definesAffected).toEqual([r.mutation.define]);
    expect(r.source.match(/Encounter\."[^"]+"/g)!.length).toBeGreaterThan(0);
  });

  it('threshold_change swaps a numeric age helper', () => {
    const r = mutateThresholdChange(SOURCE, seededRng(2));
    expect(r.source).not.toBe(SOURCE);
    expect(r.mutation.kind).toBe('threshold_change');
    // Mutation hit a "less than" or "more than or equal to" reference.
    expect(r.mutation.original).toMatch(/Client's age is (less than|more than or equal to)/);
    expect(r.mutation.modified).toMatch(/Client's age is (less than|more than or equal to)/);
  });

  it('precondition_drop removes one and-clause line and shortens the file', () => {
    const r = mutatePreconditionDrop(SOURCE, seededRng(3));
    expect(r.mutation.kind).toBe('precondition_drop');
    expect(r.source.split('\n').length).toBe(SOURCE.split('\n').length - 1);
    expect(/^\s+and\s+/.test(r.mutation.original)).toBe(true);
  });

  it('guidance_text_swap swaps two distinct guidance blocks and records both endpoints', () => {
    const r = mutateGuidanceTextSwap(SOURCE, seededRng(4));
    expect(r.mutation.kind).toBe('guidance_text_swap');
    expect(r.source).not.toBe(SOURCE);
    expect(r.mutation.definesAffected.length).toBe(2);
    expect(r.mutation.definesAffected[0]).not.toBe(r.mutation.definesAffected[1]);
    expect(r.source).toMatch(/define "[^"]+ Guidance":/);
  });

  it('comparator_flip flips is-null or != in a boolean position', () => {
    const r = mutateComparatorFlip(SOURCE, seededRng(5));
    expect(r.mutation.kind).toBe('comparator_flip');
    expect(r.source).not.toBe(SOURCE);
  });

  it('mutators are deterministic given the same seed', () => {
    const a = mutateBooleanOpFlip(SOURCE, seededRng(7));
    const b = mutateBooleanOpFlip(SOURCE, seededRng(7));
    expect(a.source).toBe(b.source);
    expect(a.mutation.approxLine).toBe(b.mutation.approxLine);
  });
});
