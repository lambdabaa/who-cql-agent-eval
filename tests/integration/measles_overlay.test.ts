import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { yamlToBundles } from '../../src/harness/yaml_to_bundle.js';

/**
 * End-to-end check that our augmented Measles overlay parses, produces one
 * bundle per row, and carries a well-typed `expected:` block on every case.
 *
 * This is the harness's load-bearing fixture — if it stops parsing, the
 * Tier-3 grader has nothing to grade against.
 */

const OVERLAY = join('tests', 'dak', 'IMMZD2DTMeaslesLowTransmissionLogic.yaml');

describe('Measles overlay (Phase 0 v0 fixture)', () => {
  const yamlText = readFileSync(OVERLAY, 'utf8');
  const result = yamlToBundles(yamlText, { today: '2026-01-15' });

  it('has one case per WHO test row', () => {
    expect(result.cases.map((c) => c.patientId)).toEqual([
      'Measles22.1',
      'Measles23.3',
      'Measles24.3',
      'Measles25.2',
      'Measles26.3',
      'Measles27.3',
      'Measles28.1',
    ]);
  });

  it('attaches an expected block to every case', () => {
    for (const c of result.cases) {
      expect(c.expected, `case ${c.patientId} is missing expected:`).toBeDefined();
      expect(c.expected!.defines, `case ${c.patientId} has empty defines`).not.toEqual({});
    }
  });

  it('builds a non-empty bundle for every case', () => {
    for (const c of result.cases) {
      expect(c.bundle.entry.length, `case ${c.patientId}`).toBeGreaterThan(0);
      const patient = c.bundle.entry.find((e) => e.resource.resourceType === 'Patient');
      expect(patient, `case ${c.patientId} is missing a Patient`).toBeDefined();
    }
  });

  it('encodes birth-anchored Measles MCV1 administration at +12m', () => {
    const m25 = result.cases.find((c) => c.patientId === 'Measles25.2')!;
    const measles = m25.bundle.entry.find(
      (e) => e.resource.resourceType === 'Immunization',
    )!.resource as unknown as { occurrenceDateTime: string };
    // birth = today - 13m = 2024-12-15; +12m = 2025-12-15
    expect(measles.occurrenceDateTime).toBe('2025-12-15');
  });

  it('preserves Guidance newlines for the long-form equals matcher', () => {
    const m23 = result.cases.find((c) => c.patientId === 'Measles23.3')!;
    const guidance = m23.expected!.defines['Guidance'];
    expect(typeof guidance).toBe('object');
    expect((guidance as { equals: string }).equals).toContain('\n');
  });
});
