# Task AUDIT: Find any L2 ↔ L3 inconsistencies in a real WHO library

You are given:

- `inputs/L2_table.md` — the canonical L2 decision table for IMMZ.D2.DT.Measles.OngoingTransmission.
- `inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` — the dependency library the library calls into.
- `inputs/library.cql` — the **real, unmodified** Logic library (`IMMZD2DTMeaslesOngoingTransmissionLogic`) as published in the smart-immunizations / smart-anc DAK.

## Important

This is **not a test corpus**. The library is the actual production CQL.
The L2 brief in this task was transcribed by the harness authors from the
published library annotations. A perfect match between brief and library
is the *expected* default state.

Do not invent inconsistencies. Only flag a finding if the library demonstrably
contradicts what the brief says — wrong define name, wrong precondition,
wrong threshold, wrong guidance text, missing conjunct, etc. If everything
matches, return an empty `findings` array.

## Output

Emit a single file as a fenced block tagged `path=findings.json`:

```json
{
  "findings": [
    {
      "define": "Client is due for MCV1",
      "approximateLine": 82,
      "description": "L2 brief specifies preconditions A AND B AND C, but library uses A AND B (missing C).",
      "severity": "high"
    }
  ]
}
```

If no findings: `{"findings": []}`.

Rules:

- Every `finding` must point to a real define in the library and identify
  what specifically diverges from the brief.
- `severity` is optional (`low` / `medium` / `high`).
- Do not flag stylistic differences (whitespace, comment formatting, define ordering).
- Do not flag the absence of optional features the brief doesn't require.
