import { describe, it, expect } from 'vitest';
import {
  backfillFromYaml,
  backfillFromTestValidation,
  mergeBackfills,
  renderExpectedBlock,
} from '../../src/harness/backfill_expected.js';

const yamlText = `
---
### Client is not due for MCV1
### "Immunization recommendation status" = "Not due"
id: Measles22.1
birth: -1d
---
### Client is due for MCV1
id: Measles23.3
birth: -12m
`;

describe('backfillFromYaml', () => {
  it('captures ### comments and matches known defines', () => {
    const cases = backfillFromYaml(yamlText, ['Client is not due for MCV1', 'Client is due for MCV1']);
    expect(cases.map((c) => c.patientId)).toEqual(['Measles22.1', 'Measles23.3']);
    expect(cases[0]!.defines['Client is not due for MCV1']).toBe(true);
    expect(cases[1]!.defines['Client is due for MCV1']).toBe(true);
  });
});

const cqlText = `
define "Test Validation":
  case
    when Patient.id = 'Measles22.1' then "Client is not due for MCV1 Case 1" and "Guidance" = 'Should not vaccinate client with MCV1 as client\\'s age is less than 12 months.'
    when Patient.id = 'Measles23.3' then "Client is due for MCV1" and "Guidance" = 'Should vaccinate.'
    else 'No test case set'
  end
`;

describe('backfillFromTestValidation', () => {
  it('extracts define names and Guidance strings per patient', () => {
    const cases = backfillFromTestValidation(cqlText);
    const m22 = cases.find((c) => c.patientId === 'Measles22.1')!;
    expect(m22.defines['Client is not due for MCV1 Case 1']).toBe(true);
    expect(m22.defines['Guidance']).toContain("Should not vaccinate");
    const m23 = cases.find((c) => c.patientId === 'Measles23.3')!;
    expect(m23.defines['Client is due for MCV1']).toBe(true);
    expect(m23.defines['Guidance']).toBe('Should vaccinate.');
  });
});

describe('mergeBackfills + renderExpectedBlock', () => {
  it('merges by patientId with Test-Validation winning on overlap', () => {
    const fromYaml = backfillFromYaml(yamlText, ['Client is due for MCV1']);
    const fromCql = backfillFromTestValidation(cqlText);
    const merged = mergeBackfills(fromYaml, fromCql);
    const m23 = merged.find((c) => c.patientId === 'Measles23.3')!;
    expect(m23.defines['Guidance']).toBe('Should vaccinate.');
    expect(m23.defines['Client is due for MCV1']).toBe(true);
  });

  it('renders a YAML expected: block', () => {
    const cases = backfillFromTestValidation(cqlText);
    const out = renderExpectedBlock(cases[0]!);
    expect(out).toContain('expected:');
    expect(out).toContain('defines:');
    expect(out).toMatch(/"Client is not due for MCV1 Case 1": true/);
  });
});
