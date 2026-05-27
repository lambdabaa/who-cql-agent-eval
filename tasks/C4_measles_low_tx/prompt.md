# Task C4: Predict CQL define outputs without executing

You are given one WHO SMART Guidelines Logic library, its immediate
dependency (`IMMZD2DTMeaslesEncounterElements`), and a set of patient FHIR
Bundles. For each patient, predict the value of the listed CQL defines as if
you had executed the library.

You may not run code. Reason through the CQL by hand.

## Inputs

- `inputs/library.cql` — the Logic library (`IMMZD2DTMeaslesLowTransmissionLogic`).
- `inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` — the Encounter helper
  library (the Logic library calls into this via `Encounter."…"`).
- `inputs/patients/<patientId>.json` — one FHIR Bundle per patient. The
  Bundle is exactly what the harness loads into cql-execution.

## Evaluation context

- `Today` parameter is fixed to `2026-01-15` for every patient.
- `EncounterId` is `null` (no Encounter resource is present).
- Patient context (no separate Encounter scope).

## Defines to predict

For every patient listed in `task.json`, predict the value of every define
listed in `task.json.defines`. Booleans are `true` or `false`. Strings
are the exact string the library would return (an empty string `""` if the
library's case-expression falls through to `''`).

## Output format

Write `outputs/predictions.json` as JSON in this exact shape:

```json
{
  "<patientId>": {
    "<define name>": <value>,
    ...
  },
  ...
}
```

Values must be JSON scalars: `true`, `false`, a string, a number, or
`null`. Do not include any other top-level keys.

Emit the file as a fenced block tagged `path=predictions.json`.
