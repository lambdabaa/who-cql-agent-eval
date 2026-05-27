# IMMZ.D2.DT.Measles.LowTransmission — Decision Table

**Setting:** Countries with low levels of measles transmission.
**Schedule:** MCV1 at 12 months, MCV2 at 15 months.
**Trigger:** `IMMZ.D2` — determine required vaccination(s) if any.

The Logic library MUST publish exactly the boolean output defines listed
below, plus the matching `<output> Guidance` string defines, plus the
top-level `Guidance` and `Has Guidance` aggregator defines.

All preconditions reference defines exposed by the
`IMMZD2DTMeaslesEncounterElements` library (alias as `Encounter`). See
`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` for the exact names.

## Rows

### Row R1 — `Client is not due for MCV1 Case 1`

- Precondition: `Encounter."Client's age is less than 12 months"`
- Output define (Boolean): `Client is not due for MCV1 Case 1`
- Guidance: `Should not vaccinate client with MCV1 as client's age is less than 12 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.`

### Row R2 — `Client is due for MCV1`

- Preconditions (AND):
  - `Encounter."No measles primary series doses were administered"`
  - `Encounter."Client's age is more than or equal to 12 months"`
  - `Encounter."No live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is due for MCV1`
- Guidance: `Should vaccinate client with MCV1 as no measles doses were administered, client is within appropriate age range and no live vaccine was administered in the past 4 weeks.\nCheck for contraindications.`

### Row R3 — `Client is not due for MCV1 Case 2`

- Preconditions (AND):
  - `Encounter."No measles primary series doses were administered"`
  - `Encounter."Client's age is more than or equal to 12 months"`
  - `Encounter."Live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is not due for MCV1 Case 2`
- Guidance: `Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.`

### Row R4 — `Client is not due for MCV2 Case 1`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is less than 15 months"`
- Output define (Boolean): `Client is not due for MCV2 Case 1`
- Guidance: `Should not vaccinate client with MCV2 as client's age is less than 15 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.`

### Row R5 — `Client is due for MCV2`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is more than or equal to 15 months"`
  - `Encounter."No live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is due for MCV2`
- Guidance: `Should vaccinate client with MCV2 as client is within appropriate age range and no live vaccine administered in the past 4 weeks.\nCheck for contraindications.`

### Row R6 — `Client is not due for MCV2 Case 2`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is more than or equal to 15 months"`
  - `Encounter."Live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is not due for MCV2 Case 2`
- Guidance: `Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.`

### Row R7 — `Measles primary series is complete`

- Precondition: `Encounter."MCV2 was administered"`
- Output define (Boolean): `Measles primary series is complete`
- Guidance: `Measles primary series is complete. Two measles primary series doses were administered.\nCheck if a measles supplementary dose is appropriate for the client.`

## Aggregator defines

The library must also include:

- `Client is not due for MCV1` = `"Client is not due for MCV1 Case 1" or "Client is not due for MCV1 Case 2"`
- `Client is not due for MCV2` = `"Client is not due for MCV2 Case 1" or "Client is not due for MCV2 Case 2"`
- One `<output> Guidance` string define per Boolean output above. The
  Case-1/Case-2 outputs share a `<aggregator> Guidance` case-expression
  selecting the correct guidance text (see the convention for "Client is not
  due for MCV1 Guidance" below).
- `Guidance` — case-expression returning the active guidance string. Precedence:
  not-due-MCV1 → due-MCV1 → not-due-MCV2 → due-MCV2 → primary-series-complete →
  empty string.
- `Has Guidance` = `"Guidance" is not null and "Guidance" != ''`.

### Convention for case-aggregated guidance

For "Client is not due for MCV1":

```
define "Client is not due for MCV1 Guidance":
  case
    when "Client is not due for MCV1 Case 1" then '<Case 1 guidance>'
    when "Client is not due for MCV1 Case 2" then '<Case 2 guidance>'
    else ''
  end
```

For "Client is not due for MCV2" follow the same pattern.
