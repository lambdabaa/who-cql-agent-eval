# IMMZ.D2.DT.Measles.SupplementaryDose — Decision Table

**Setting:** Determine whether a measles supplementary dose should be administered.
**Trigger:** `IMMZ.D2` — determine required vaccination(s) if any.

This decision table runs *after* the primary series is complete. There are no
age preconditions — only "has the supplementary dose already been given?",
"is the routine schedule complete?", and "was a live vaccine given in the
past 4 weeks?".

All preconditions reference defines exposed by the
`IMMZD2DTMeaslesEncounterElements` library (alias as `Encounter`).

## Rows

### Row R1 — `Client is not due for measles supplementary dose`

- Preconditions (AND):
  - `Encounter."Measles supplementary dose was not administered"`
  - `Encounter."Measles routine immunization schedule is complete"`
  - `Encounter."Live vaccine was administered in the past 4 weeks"`
- Output define (Boolean): `Client is not due for measles supplementary dose`
- Guidance: `Should not vaccinate client with measles supplementary dose as live vaccine was administered in the past 4 weeks.\nCheck for any vaccines due and inform the caregiver of when to come back for supplementary dose.`

### Row R2 — `Consider measles supplementary dose. Create a clinical note`

- Preconditions (AND):
  - `Encounter."Measles supplementary dose was not administered"`
  - `Encounter."Measles routine immunization schedule is complete"`
  - `Encounter."No live vaccine was administered in the past 4 weeks"`
- Output define (Boolean): `Consider measles supplementary dose. Create a clinical note` (the trailing period is part of the literal name)
- Guidance: `May vaccinate client with measles supplementary dose as supplementary dose was not administered, measles routine immunization schedule is complete and no live vaccine administered in the past 4 weeks.\nCheck if one of the measles supplementary dose specific scenarios is applicable.`

### Row R3 — `Measles immunization schedule is complete`

- Precondition: `Encounter."Measles supplementary dose was administered"`
- Output define (Boolean): `Measles immunization schedule is complete`
- Guidance: `Measles immunization schedule is complete. Measles supplementary dose was administered.`

## Aggregator defines

- `Guidance` — case-expression selecting the active row's guidance string.
  Precedence: not-due → consider → schedule-complete → empty.
- `Has Guidance` = `"Guidance" is not null and "Guidance" != ''`.

Each row's guidance literal is published as its own `<row output> Guidance`
string define (no case-aggregator wrapping).
