# IMMZ.D2.DT.Measles.OngoingTransmission — Decision Table

**Setting:** Countries with ongoing measles transmission and high mortality risk.
**Schedule:** MCV1 at 9 months, MCV2 at 15 months.
**Trigger:** `IMMZ.D2` — determine required vaccination(s) if any.

All preconditions reference defines exposed by the
`IMMZD2DTMeaslesEncounterElements` library (alias as `Encounter`). See
`inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` for the exact names.

## Rows

### Row R1 — `Client is not due for first dose of measles-containing vaccine (MCV1)`

- Precondition: `Encounter."Client's age is less than 9 months"`
- Output define (Boolean): `Client is not due for first dose of measles-containing vaccine (MCV1)`
- Guidance: `Should not vaccinate client as client's age is less than 9 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.`

### Row R2 — `Client is due for MCV1`

- Preconditions (AND):
  - `Encounter."No measles primary series doses were administered"`
  - `Encounter."Client's age is more than or equal to 9 months"`
  - `Encounter."No live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is due for MCV1`
- Guidance: `Should vaccinate client with MCV1 as no measles doses were administered, client is within appropriate age range and no live vaccine administered in the past 4 weeks.\nCheck for contraindications.`

### Row R3 — `Client is not due for MCV1`

- Preconditions (AND):
  - `Encounter."No measles primary series doses were administered"`
  - `Encounter."Client's age is more than or equal to 9 months"`
  - `Encounter."Live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is not due for MCV1`
- Guidance: `Should not vaccinate client with MCV1 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV1.`

### Row R4 — `Client is not due for second dose of measles-containing vaccine (MCV2)`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is less than 15 months"`
- Output define (Boolean): `Client is not due for second dose of measles-containing vaccine (MCV2)`
- Guidance: `Should not vaccinate client with MCV2 as client's age is less than 15 months.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.`

### Row R5 — `Client is due for MCV2`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is more than or equal to 15 months"`
  - `Encounter."No live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is due for MCV2`
- Guidance: `Should vaccinate client with MCV2 as client is within appropriate age range and no live vaccine administered in the past 4 weeks.\nCheck for contraindications.`

### Row R6 — `Client is not due for MCV2`

- Preconditions (AND):
  - `Encounter."MCV1 was administered"`
  - `Encounter."Client's age is more than or equal to 15 months"`
  - `Encounter."Live vaccine was administered in the last 4 weeks"`
- Output define (Boolean): `Client is not due for MCV2`
- Guidance: `Should not vaccinate client with MCV2 as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for MCV2.`

### Row R7 — `Measles primary series is complete`

- Precondition: `Encounter."MCV2 was administered"`
- Output define (Boolean): `Measles primary series is complete`
- Guidance: `Measles primary series is complete. Two measles primary series doses were administered.\nCheck if a measles supplementary dose is appropriate for the client.`

## Aggregator defines

- `Guidance` — case-expression selecting the appropriate row's guidance string. Precedence: not-due-MCV1-Case1 (age) → due-MCV1 → not-due-MCV1 (live-vaccine) → not-due-MCV2-Case1 (age) → due-MCV2 → not-due-MCV2 (live-vaccine) → primary-series-complete → empty.
- `Has Guidance` = `"Guidance" is not null and "Guidance" != ''`.

Each row's guidance literal is published as its own `<row output> Guidance`
string define (no case-aggregator wrapping like LowTransmission has, because
the cases are distinguished by referenced define name rather than by a
shared "Case 1 / Case 2" naming pattern).
