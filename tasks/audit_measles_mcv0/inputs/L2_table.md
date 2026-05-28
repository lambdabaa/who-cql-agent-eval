# IMMZ.D2.DT.Measles.MCV0 — Decision Table

**Setting:** Determine if the client is due for measles-containing vaccine dose 0 (MCV0).
**Schedule:** MCV0 is administered between 6 and 9 months of age, before the routine MCV1 dose.
**Trigger:** `IMMZ.D2` — determine required vaccination(s) if any.

The Logic library MUST publish exactly the boolean output defines listed
below, plus the matching `<output> Guidance` string defines, plus the
top-level `Guidance` and `Has Guidance` aggregator defines.

All preconditions reference defines exposed by the
`IMMZD2DTMeaslesEncounterElements` library (alias as `Encounter`). See
`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` for the exact names.

## Rows

### Row R1 — `Client is not due for MCV0 Case 1`

- Precondition: `Encounter."Client's age is less than 6 months"`
- Output define (Boolean): `Client is not due for MCV0 Case 1`
- Guidance: `Should not vaccinate client with MCV0 as client's age is less than 6 months. Check for any vaccines due and inform the caregiver of when to come back for MCV0.`

### Row R2 — `Client is not due for MCV0 Case 2`

- Preconditions (AND):
  - `Encounter."MCV0 was not administered"`
  - `Encounter."Client's age is between 6 months and 9 months"`
  - `Encounter."Live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is not due for MCV0 Case 2`
- Guidance: `Should not vaccinate client with MCV0 as live vaccine was administered in the past 4 weeks. Check for any vaccines due and inform the caregiver of when to come back for MCV0.`

### Row R3 — `Client is not due for MCV0 Case 3`

- Precondition: `Encounter."Client's age is more than or equal to 9 months"`
- Output define (Boolean): `Client is not due for MCV0 Case 3`
- Guidance: `Should not vaccinate client with MCV0 as client's age is more than 9 months.\nCheck measles routine immunization schedule.`

### Row R4 — `Client is not due for MCV0 Case 4`

- Precondition: `Encounter."MCV0 was administered"`
- Output define (Boolean): `Client is not due for MCV0 Case 4`
- Guidance: `MCV0 was administered.\nCheck measles routine immunization schedule.`

### Row R5 — `Consider MCV0.`

- Preconditions (AND):
  - `Encounter."MCV0 was not administered"`
  - `Encounter."Client's age is between 6 months and 9 months"`
  - `Encounter."No live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Consider MCV0.` (note the trailing period — this is the literal define name)
- Guidance: `May vaccinate client with MCV0 as client is within appropriate age range, MCV0 was not administered and no live vaccine was administered in the past 4 weeks. Check if one of the MCV0 specific scenarios is applicable.`

## Aggregator defines

The library must also include:

- `Client is not due for MCV0` = `"Client is not due for MCV0 Case 1" or "Client is not due for MCV0 Case 2" or "Client is not due for MCV0 Case 3" or "Client is not due for MCV0 Case 4"`
- A `Client is not due for MCV0 Guidance` case-expression returning the right per-case guidance string.
- `Guidance` — case-expression returning the active guidance string. Precedence:
  not-due-MCV0 → consider-MCV0 → empty string.
- `Has Guidance` = `"Guidance" is not null and "Guidance" != ''`.

### Convention for case-aggregated guidance

```
define "Client is not due for MCV0 Guidance":
  case
    when "Client is not due for MCV0 Case 1" then '<Case 1 guidance>'
    when "Client is not due for MCV0 Case 2" then '<Case 2 guidance>'
    when "Client is not due for MCV0 Case 3" then '<Case 3 guidance>'
    when "Client is not due for MCV0 Case 4" then '<Case 4 guidance>'
    else ''
  end
```
