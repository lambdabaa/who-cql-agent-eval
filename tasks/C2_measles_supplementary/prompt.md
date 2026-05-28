# Task C2: Detect inconsistencies between L2 brief and Logic CQL

You are given:

- `inputs/L2_table.md` — the canonical L2 decision table for IMMZ.D2.DT.Measles.SupplementaryDose.
- `inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` — the dependency library exposing `Encounter."…"` helpers the variants call into.
- `inputs/variants/v01.cql` through `inputs/variants/v24.cql` — 24 candidate Logic libraries (`IMMZD2DTMeaslesSupplementaryDoseLogic`). Each is either:
  - byte-identical to a known-good reference (a "control"), or
  - has exactly one injected bug from the taxonomy below.

The corpus is balanced — roughly half the variants are mutated, half are controls.

## Bug taxonomy

You may classify each detection as one of:

- `boolean_op_flip` — an `and`/`or` token is swapped at the start of a continuation line.
- `reference_rename` — an `Encounter."X"` reference is swapped for a *different entity* (e.g. `"MCV1 was administered"` → `"MCV2 was administered"`, or polarity flipped).
- `threshold_change` — an `Encounter."X"` reference is swapped for one with the same predicate but a different numeric threshold (e.g. `"…less than 12 months"` → `"…less than 15 months"`). Requires knowing the actual clinical schedule.
- `precondition_drop` — one conjunct of a multi-precondition `and` is missing.
- `guidance_text_swap` — a `<X> Guidance` string literal is swapped with another output's guidance text.
- `comparator_flip` — `is not null` ↔ `is null` or `!=` ↔ `=` is flipped in a scalar comparison.
- `none` — no bug; the variant matches the L2 brief.

## Your job

For each variant, decide whether it diverges from the L2 brief. If it does, identify the define, an approximate line number, and (optionally) the bug kind.

## Output

Emit a single file as a fenced block tagged `path=detections.json`:

```json
{
  "v01": {
    "hasBug": true,
    "define": "Client is not due for MCV1 Case 2",
    "approximateLine": 49,
    "mutationKind": "boolean_op_flip",
    "description": "first 'and' between conjuncts flipped to 'or'"
  },
  "v02": {
    "hasBug": false
  }
}
```

Rules:

- Every variant id must appear as a top-level key.
- `hasBug` is required. `define`, `approximateLine`, `mutationKind`, and `description` are optional but each correctly-filled field improves the score.
- The primary metric is `hasBug` precision/recall. Localization (`define`) and classification (`mutationKind`) are secondary axes.
