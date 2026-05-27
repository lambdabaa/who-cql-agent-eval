import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FhirBundle } from './yaml_to_bundle.js';

/**
 * Read a directory tree of per-resource FHIR JSON files (as produced by the
 * stock WHO `makeExample.js` script) and assemble a single FHIR R4 collection
 * Bundle.
 *
 * The expected layout matches WHO's:
 *
 *   <root>/<PatientId>/Patient/<PatientId>.json
 *   <root>/<PatientId>/Immunization/<localId>-<PatientId>.json
 *   <root>/<PatientId>/Observation/<localId>-<PatientId>.json
 *   ...
 *
 * Use this when an agent is being evaluated on its ability to consume the
 * existing WHO-published JSON test data unmodified; the YAML→Bundle path
 * (`yaml_to_bundle.ts`) is preferred when running against `examples.yaml`.
 */

export interface LoadBundleResult {
  patientId: string;
  bundle: FhirBundle;
}

export function loadBundlesFromDir(root: string): LoadBundleResult[] {
  const out: LoadBundleResult[] = [];
  for (const entry of readdirSync(root)) {
    const patientDir = join(root, entry);
    if (!statSync(patientDir).isDirectory()) continue;
    out.push(loadBundleFromPatientDir(patientDir, entry));
  }
  return out;
}

export function loadBundleFromPatientDir(patientDir: string, patientId: string): LoadBundleResult {
  const resources: Array<{ resourceType: string; id: string; [k: string]: unknown }> = [];
  for (const resourceType of readdirSync(patientDir)) {
    const typeDir = join(patientDir, resourceType);
    if (!statSync(typeDir).isDirectory()) continue;
    for (const file of readdirSync(typeDir)) {
      if (!file.endsWith('.json')) continue;
      const raw = JSON.parse(readFileSync(join(typeDir, file), 'utf8'));
      resources.push(raw);
    }
  }
  return {
    patientId,
    bundle: {
      resourceType: 'Bundle',
      type: 'collection',
      entry: resources.map((r) => ({ fullUrl: `urn:uuid:${r.resourceType}/${r.id}`, resource: r })),
    },
  };
}
