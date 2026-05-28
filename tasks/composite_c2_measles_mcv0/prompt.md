# Task COMPOSITE C2: Detect *every* inconsistency between L2 brief and Logic CQL

You are given:

- `inputs/L2_table.md` — the canonical L2 decision table for IMMZ.D2.DT.Measles.MCV0.
- `inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` — the dependency library the variants call into.
- `inputs/variants/v01.cql` through `inputs/variants/v36.cql` — 36 candidate Logic libraries (`IMMZD2DTMeaslesMCVDose0Logic`). Each has **0 to 5** injected bugs.

Unlike the single-bug detection task, the number of bugs per variant is
not fixed. Some variants are clean controls (empty `findings`); others
have multiple independent bugs you must each flag separately.

## Bug taxonomy

Each finding's `mutationKind` may be:

- `boolean_op_flip` — an `and`/`or` token is swapped at a continuation line.
- `reference_rename` — an `Encounter."X"` reference is swapped for a *different entity*.
- `threshold_change` — an `Encounter."X"` reference is swapped for one with the same predicate but a different numeric threshold.
- `precondition_drop` — one conjunct of a multi-precondition `and` is missing.
- `guidance_text_swap` — a `<X> Guidance` string literal is swapped with another output's guidance text.
- `comparator_flip` — `is not null` ↔ `is null`, `!=` ↔ `=`, `>=` ↔ `>`, or `<=` ↔ `<`.

## Output

Emit a single file as a fenced block tagged `path=detections.json`:

```json
{
  "v01": { "findings": [] },
  "v07": {
    "findings": [
      {
        "define": "Client is not due for MCV1 Case 2",
        "approximateLine": 49,
        "mutationKind": "boolean_op_flip",
        "description": "'and' flipped to 'or'"
      }
    ]
  }
}
```

Rules:

- Every variant id must appear as a top-level key.
- `findings` is required (use `[]` for controls).
- The primary metric is **set-based F1** over (variant, define) pairs:
  precision = findings that match an injected bug / total findings;
  recall = injected bugs flagged / total injected bugs.
- Localization is matched on `define` name; `mutationKind` is a secondary
  classification axis. Imprecise `approximateLine` is not penalised.
- Do not invent bugs to game recall — false positives cost precision.
