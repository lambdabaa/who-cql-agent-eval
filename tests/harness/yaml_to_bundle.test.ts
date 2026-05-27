import { describe, it, expect } from 'vitest';
import { parseISO } from 'date-fns';
import { yamlToBundles, shiftDate } from '../../src/harness/yaml_to_bundle.js';

const TODAY = '2026-01-15';
const todayDate = () => parseISO(TODAY);

describe('shiftDate', () => {
  it('returns absolute YYYY-MM-DD unchanged', () => {
    expect(shiftDate('2020-03-04', undefined, todayDate())).toBe('2020-03-04');
  });

  it('anchors birth-relative shifts to the birth date', () => {
    expect(shiftDate('b+12m', '2025-01-15', todayDate())).toBe('2026-01-15');
  });

  it('anchors un-prefixed shifts to today', () => {
    expect(shiftDate('-2w', undefined, todayDate())).toBe('2026-01-01');
  });

  it('supports y/m/w/d/h units', () => {
    const t = todayDate();
    expect(shiftDate('-1y', undefined, t)).toBe('2025-01-15');
    expect(shiftDate('-1m', undefined, t)).toBe('2025-12-15');
    expect(shiftDate('+1d', undefined, t)).toBe('2026-01-16');
  });
});

describe('yamlToBundles — Measles fixtures', () => {
  const yamlText = `
---
id: Measles22.1
birth: -1d
patient:
  fhir:
    gender: female
---
id: Measles24.3
birth: -12m
patient:
  fhir:
    gender: female
immunization:
  flu:
    vaccine:
      code: XM5V64
      system: http://id.who.int/icd/release/11/mms
      display: Influenza vaccines, live attenuated
    fhir:
      occurrenceDateTime: -2w
`;

  it('parses multiple documents into one case each', () => {
    const result = yamlToBundles(yamlText, { today: TODAY });
    expect(result.cases.map((c) => c.patientId)).toEqual(['Measles22.1', 'Measles24.3']);
  });

  it('emits one Patient + one Immunization per case where applicable', () => {
    const result = yamlToBundles(yamlText, { today: TODAY });
    const second = result.cases[1]!;
    const resourceTypes = second.bundle.entry.map((e) => e.resource.resourceType).sort();
    expect(resourceTypes).toEqual(['Immunization', 'Patient']);
  });

  it('resolves birth-anchored fhir dates against the patient birth date', () => {
    const result = yamlToBundles(yamlText, { today: TODAY });
    const measles = result.cases[1]!;
    const patient = measles.bundle.entry.find((e) => e.resource.resourceType === 'Patient')!.resource as unknown as {
      birthDate: string;
    };
    expect(patient.birthDate).toBe('2025-01-15');
    const immz = measles.bundle.entry.find((e) => e.resource.resourceType === 'Immunization')!.resource as unknown as {
      occurrenceDateTime: string;
    };
    expect(immz.occurrenceDateTime).toBe('2026-01-01'); // today - 2w
  });

  it('applies the line-254 expirationDate fix by default (today + 1y)', () => {
    const result = yamlToBundles(yamlText, { today: TODAY });
    const immz = result.cases[1]!.bundle.entry.find((e) => e.resource.resourceType === 'Immunization')!
      .resource as unknown as { expirationDate: string };
    // shiftDate('1y', ...) has no `b` anchor, so the start is `today`, not
    // `birth`. expirationDate = today + 1y = 2027-01-15. This matches the
    // most likely authorial intent of the broken `-` line in makeExample.js.
    expect(immz.expirationDate).toBe('2027-01-15');
  });

  it('reproduces the original silent no-op when applyKnownBugFixes=false', () => {
    const result = yamlToBundles(yamlText, { today: TODAY, applyKnownBugFixes: false });
    const immz = result.cases[1]!.bundle.entry.find((e) => e.resource.resourceType === 'Immunization')!
      .resource as unknown as { expirationDate: string };
    expect(immz.expirationDate).toBe('2026-12-31'); // the resource template default
  });
});

describe('yamlToBundles — expected: block', () => {
  it('round-trips an inline expected block through the schema', () => {
    const yamlText = `
---
id: Measles23.3
birth: -12m
expected:
  row: R2
  defines:
    "Client is due for MCV1": true
    "Guidance":
      equals: "x"
`;
    const result = yamlToBundles(yamlText, { today: TODAY });
    const exp = result.cases[0]!.expected!;
    expect(exp.row).toBe('R2');
    expect(exp.defines['Client is due for MCV1']).toBe(true);
  });
});
