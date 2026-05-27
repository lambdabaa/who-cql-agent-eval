import { parseAllDocuments } from 'yaml';
import { addDays, addHours, addMonths, addWeeks, addYears, formatISO, parseISO } from 'date-fns';
import type { ExpectedBlock } from './expected_schema.js';
import { ExpectedBlockSchema } from './expected_schema.js';

/**
 * Faithful TypeScript port of `tools/node/makeExample.js` in
 * `WorldHealthOrganization/smart-immunizations` (pinned at SHA b16245f71).
 *
 * Deliberately tracks the original's structure line-for-line so divergences
 * remain auditable. Two known semantic differences from the JS original:
 *
 *   1. `Immunization.expirationDate` is set to `birth + 1y` (the original has
 *      `immunization.expirationDate - shiftDate("1y", birth)` at line ~254 —
 *      a stray `-` instead of `=`, which silently no-ops. The default
 *      `expirationDate: "2026-12-31"` on the resource template is what
 *      actually ends up persisted today. The port writes the intended value,
 *      gated by `applyKnownBugFixes` so we can reproduce the original
 *      behavior for regression testing.)
 *   2. Output is a single in-memory FHIR Bundle rather than a tree of JSON
 *      files on disk. The shape of each resource is identical.
 *
 * Inputs accepted: the WHO YAML text plus a deterministic harness `today`
 * (used to anchor un-anchored relative dates and the `Today` CQL parameter).
 */

const SOURCE_REVISION = 'smart-immunizations@b16245f71';

export interface YamlToBundleOptions {
  /** Wall-clock anchor for relative dates without a `b` (birth) prefix. */
  today: string; // YYYY-MM-DD
  /**
   * If true, port the `expirationDate = ...` bug-fix described above.
   * Default true. Set false to reproduce the original silent no-op.
   */
  applyKnownBugFixes?: boolean;
}

export interface ScenarioCase {
  /** Patient id from the YAML document (e.g. `Measles23.3`). */
  patientId: string;
  /** Resolved birth date in YYYY-MM-DD form. */
  birth: string;
  /** Optional expected block parsed via expected_schema. */
  expected?: ExpectedBlock;
  /** FHIR R4 Bundle (transaction-less collection) of all resources. */
  bundle: FhirBundle;
}

export interface YamlToBundleResult {
  cases: ScenarioCase[];
  sourceRevision: string;
}

export interface FhirBundle {
  resourceType: 'Bundle';
  type: 'collection';
  entry: Array<{ fullUrl: string; resource: FhirResource }>;
}

interface FhirResource {
  resourceType: string;
  id: string;
  [key: string]: unknown;
}

/**
 * Parse a WHO `examples.yaml` (multi-document) and return one Bundle per
 * patient document, plus any parsed `expected:` block.
 */
export function yamlToBundles(yamlText: string, options: YamlToBundleOptions): YamlToBundleResult {
  const today = parseISO(options.today);
  if (Number.isNaN(today.getTime())) {
    throw new Error(`invalid options.today: ${options.today}`);
  }
  const applyFixes = options.applyKnownBugFixes ?? true;

  const docs = parseAllDocuments(yamlText);
  const cases: ScenarioCase[] = [];

  for (const doc of docs) {
    const raw = doc.toJSON();
    if (raw == null) continue;
    const opts: Record<string, unknown> = raw as Record<string, unknown>;
    if (typeof opts.id !== 'string') {
      throw new Error('YAML doc missing required `id` field');
    }
    if (typeof opts.birth !== 'string') {
      throw new Error(`YAML doc ${opts.id} missing required \`birth\` field`);
    }
    const birth = shiftDate(opts.birth, undefined, today);
    opts.birth = birth;

    const entries: FhirResource[] = [];

    const patientOpts = (opts.patient ?? {}) as Record<string, unknown>;
    entries.push(makePatient(opts.id, patientOpts, birth, today, applyFixes));

    if (isRecord(opts.immunization)) {
      for (const [immzKey, immzVal] of Object.entries(opts.immunization)) {
        if (!isRecord(immzVal)) continue;
        if (immzVal.doses) {
          const doses = immzVal.doses as Record<string, unknown[]>;
          const newopts: Record<string, unknown> = JSON.parse(JSON.stringify(immzVal));
          delete newopts.doses;
          for (const [seriesKey, dates] of Object.entries(doses)) {
            const found = seriesKey.match(/([bps0])(\d?)/);
            const paseries = found?.[1];
            const padoses = found?.[2];
            if (!paseries) continue;
            (dates as unknown[]).forEach((date, i) => {
              const index = i + 1;
              newopts.dose = padoses ? `${paseries}${index}/${padoses}` : `${paseries}${index}`;
              if (!isRecord(newopts.fhir)) newopts.fhir = {};
              (newopts.fhir as Record<string, unknown>).occurrenceDateTime = date;
              entries.push(
                makeImmunization(`${immzKey}${paseries}${index}`, opts.id as string, newopts, birth, today, applyFixes),
              );
            });
          }
        } else {
          entries.push(makeImmunization(immzKey, opts.id as string, immzVal, birth, today, applyFixes));
        }
      }
    }

    if (isRecord(opts.condition)) {
      for (const [cKey, cVal] of Object.entries(opts.condition)) {
        if (!isRecord(cVal)) continue;
        entries.push(makeCondition(cKey, opts.id as string, cVal, birth, today));
      }
    }

    if (isRecord(opts.location)) {
      for (const [lKey, lVal] of Object.entries(opts.location)) {
        if (!isRecord(lVal)) continue;
        entries.push(makeLocation(lKey, opts.id as string, lVal, today));
      }
    }

    // contraindication shorthand → adds an Observation with code DE161
    if (isRecord(opts.contraindication)) {
      if (!isRecord(opts.observation)) opts.observation = {};
      for (const [ciKey, ciValRaw] of Object.entries(opts.contraindication)) {
        if (!isRecord(ciValRaw)) continue;
        const ciVal = ciValRaw as { effectiveDateTime?: string; code?: string; system?: string; display?: string };
        (opts.observation as Record<string, unknown>)[`ci${ciKey}`] = {
          code: {
            code: 'DE161',
            system: 'http://smart.who.int/immunizations/CodeSystem/IMMZ.D',
            display: 'Potential contraindications',
          },
          fhir: {
            effectiveDateTime: ciVal.effectiveDateTime ?? '-1d',
            valueCodeableConcept: {
              coding: [
                {
                  code: ciVal.code,
                  system: ciVal.system ?? 'http://smart.who.int/immunizations/CodeSystem/IMMZ.D',
                  display: ciVal.display,
                },
              ],
            },
          },
        };
      }
    }

    if (isRecord(opts.observation)) {
      for (const [oKey, oVal] of Object.entries(opts.observation)) {
        if (!isRecord(oVal)) continue;
        entries.push(makeObservation(oKey, opts.id as string, oVal, birth, today));
      }
    }

    if (isRecord(opts.medicationrequest)) {
      for (const [mKey, mVal] of Object.entries(opts.medicationrequest)) {
        if (!isRecord(mVal)) continue;
        entries.push(makeMedicationRequest(mKey, opts.id as string, mVal, birth, today));
      }
    }

    if (isRecord(opts.adverseevent)) {
      for (const [aKey, aVal] of Object.entries(opts.adverseevent)) {
        if (!isRecord(aVal)) continue;
        entries.push(makeAdverseEvent(aKey, opts.id as string, aVal, birth, today));
      }
    }

    let expected: ExpectedBlock | undefined;
    if (opts.expected !== undefined) {
      expected = ExpectedBlockSchema.parse(opts.expected);
    }

    cases.push({
      patientId: opts.id as string,
      birth,
      ...(expected ? { expected } : {}),
      bundle: {
        resourceType: 'Bundle',
        type: 'collection',
        entry: entries.map((r) => ({ fullUrl: `urn:uuid:${r.resourceType}/${r.id}`, resource: r })),
      },
    });
  }

  return { cases, sourceRevision: SOURCE_REVISION };
}

/**
 * Shift a date expression against an explicit anchor.
 *
 *   `YYYY-MM-DD` → returned unchanged.
 *   `[bn]?[+]?(-?\d+)[wdmyh]` → relative.
 *     `b` anchors to `birth`; otherwise anchors to `today`.
 *     Units: w=week, d=day, m=month, y=year, h=hour.
 *
 * Matches `makeExample.js#shiftDate` (`date-math`'s month/year semantics use
 * calendar arithmetic — same convention as `date-fns`'s `addMonths/addYears`).
 */
export function shiftDate(shift: string, birth: string | undefined, today: Date): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(shift)) return shift.slice(0, 10);
  const match = shift.match(/([bn]?)\+?(-?\d+)([wdmyh])/);
  if (!match) throw new Error(`unrecognized shiftDate expression: ${shift}`);
  const [, anchor, nStr, unit] = match;
  const n = parseInt(nStr!, 10);
  const start = anchor === 'b' && birth ? parseISO(birth) : today;
  let shifted: Date;
  switch (unit) {
    case 'd':
      shifted = addDays(start, n);
      break;
    case 'w':
      shifted = addWeeks(start, n);
      break;
    case 'm':
      shifted = addMonths(start, n);
      break;
    case 'y':
      shifted = addYears(start, n);
      break;
    case 'h':
      shifted = addHours(start, n);
      break;
    default:
      throw new Error(`unrecognized shiftDate unit: ${unit}`);
  }
  return formatISO(shifted, { representation: 'date' });
}

function copyFhir(resource: FhirResource, options: Record<string, unknown>, birth: string | undefined, today: Date) {
  const fhir = options.fhir;
  if (!isRecord(fhir)) return;
  for (const [key, val] of Object.entries(fhir)) {
    if (typeof val === 'string' && isDateField(key)) {
      resource[key] = shiftDate(val, birth, today);
    } else {
      resource[key] = val;
    }
  }
}

function isDateField(key: string): boolean {
  return key.endsWith('Date') || key.endsWith('DateTime') || key === 'authoredOn' || key === 'date';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function makePatient(
  id: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
  _applyFixes: boolean,
): FhirResource {
  const patient: FhirResource = {
    resourceType: 'Patient',
    id,
    name: [{ text: typeof options.name === 'string' ? options.name : id, use: 'official' }],
    birthDate: birth,
  };
  copyFhir(patient, options, birth, today);
  return patient;
}

function makeLocation(
  loc: string,
  patient: string,
  options: Record<string, unknown>,
  today: Date,
): FhirResource {
  const location: FhirResource = {
    resourceType: 'Location',
    id: `${loc}-${patient}`,
    name: options.name as string | undefined ?? '',
    status: 'active',
    address: { state: options.state as string | undefined ?? '' },
  };
  copyFhir(location, options, undefined, today);
  return location;
}

function makeAdverseEvent(
  ae: string,
  patient: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
): FhirResource {
  const aefi: FhirResource = {
    resourceType: 'AdverseEvent',
    id: `${ae}-${patient}`,
    actuality: 'actual',
    event: {},
    subject: { reference: `Patient/${patient}` },
    seriousness: {},
    outcome: {},
    suspectEntity: [
      {
        instance: { reference: `Immunization/${(options.immunization as string | undefined) ?? ''}-${patient}` },
      },
    ],
    location: options.location ? { reference: `Location/${options.location}-${patient}` } : {},
  };
  copyFhir(aefi, options, birth, today);
  return aefi;
}

function makeImmunization(
  immz: string,
  patient: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
  applyFixes: boolean,
): FhirResource {
  const immunization: FhirResource = {
    resourceType: 'Immunization',
    id: `${immz}-${patient}`,
    status: 'completed',
    vaccineCode: { coding: [options.vaccine] },
    expirationDate: '2026-12-31', // overwritten below when the bug-fix is on
    lotNumber: '123',
    patient: { reference: `Patient/${patient}` },
    location: { display: 'Vaccination Site' },
    occurrenceDateTime: '2023-12-03',
  };

  if (applyFixes) {
    // intended behavior: stamp expirationDate = birth + 1y, mirroring the
    // original line `immunization.expirationDate - shiftDate("1y", birth)`.
    immunization.expirationDate = shiftDate('1y', birth, today);
  }

  if (options.location) {
    immunization.location = { reference: `Location/${options.location}-${patient}` };
  }
  if (typeof options.dose === 'string') {
    const found = options.dose.match(/([pbs0]?)\.?(\d+)\/?(\d*)/);
    if (found) {
      const pa: Record<string, unknown> = { doseNumberString: found[2] };
      if (found[3]) pa.seriesDosesString = found[3];
      switch (found[1]) {
        case 'p':
          pa.series = 'Primary series';
          break;
        case 'b':
          pa.series = 'Booster dose';
          break;
        case 's':
          pa.series = 'Supplementary dose';
          break;
        case '0':
          pa.series = 'Dose 0';
          break;
        default:
          pa.series = 'Primary series';
      }
      immunization.protocolApplied = [pa];
    }
  }
  copyFhir(immunization, options, birth, today);
  return immunization;
}

function makeCondition(
  cond: string,
  patient: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
): FhirResource {
  const condition: FhirResource = {
    resourceType: 'Condition',
    id: `${cond}-${patient}`,
    clinicalStatus: { coding: [{ code: 'active' }] },
    code: { coding: [options.code] },
    subject: { reference: `Patient/${patient}` },
    recordedDate: '2023-11-03',
  };
  copyFhir(condition, options, birth, today);
  return condition;
}

function makeObservation(
  obs: string,
  patient: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
): FhirResource {
  const observation: FhirResource = {
    resourceType: 'Observation',
    id: `${obs}-${patient}`,
    status: 'final',
    code: { coding: [] as unknown[] },
    subject: { reference: `Patient/${patient}` },
    effectiveDateTime: '2023-11-03',
  };
  if (Array.isArray(options.code)) {
    (observation.code as { coding: unknown[] }).coding.push(...options.code);
  } else if (options.code !== undefined) {
    (observation.code as { coding: unknown[] }).coding[0] = options.code;
  }
  copyFhir(observation, options, birth, today);
  return observation;
}

function makeMedicationRequest(
  mreq: string,
  patient: string,
  options: Record<string, unknown>,
  birth: string,
  today: Date,
): FhirResource {
  const medreq: FhirResource = {
    resourceType: 'MedicationRequest',
    id: `${mreq}-${patient}`,
    status: 'draft',
    intent: 'proposal',
    medicationCodeableConcept: { coding: [options.medication] },
    subject: { reference: `Patient/${patient}` },
  };
  copyFhir(medreq, options, birth, today);
  return medreq;
}
