# ANC.DT.08 — HIV Testing Decision Table

**Setting:** Antenatal care (ANC) contact. Decide whether to conduct an HIV test for the pregnant client at this visit.
**Trigger:** ANC contact.

The Logic library publishes exactly four boolean output defines, each
guarded by a different combination of population prevalence, ANC contact
number, gestational age, and the client's known HIV status.

All preconditions reference defines exposed by the WHO ANC dependency
libraries (`Config`, `ContactData`, `Cx`); see the files under
`inputs/deps/` for the exact names.

## Rows

### Row R1 — `Should Conduct HIV test`

- Preconditions (AND):
  - `Config."Population prevalence of HIV in pregnant women" >= 5 '%'`
  - `ContactData."ANC contact number" = 1`
- Output define (Boolean): `Should Conduct HIV test`

### Row R2 — `Should Conduct HIV test 2`

- Preconditions (AND):
  - `Config."Population prevalence of HIV in pregnant women" >= 5 '%'`
  - `ContactData."Gestational age" >= 29 'weeks'`
  - `ContactData."HIV status" in Cx."HIV status - HIV negative Choices"`
- Output define (Boolean): `Should Conduct HIV test 2`

### Row R3 — `Should HIV test is optional`

- Precondition: `Config."Population prevalence of HIV in pregnant women" < 5 '%'`
- Output define (Boolean): `Should HIV test is optional` (the literal define name, including the slightly awkward grammar)

### Row R4 — `Should HIV test is not required`

- Precondition: `ContactData."HIV status" in Cx."HIV status - HIV positive Choices"`
- Output define (Boolean): `Should HIV test is not required`

## Notes

- ANC.DT.08 does not publish any `Guidance` aggregator or `Has Guidance` define. Each row's boolean stands on its own.
- The library uses inline numeric literals with CQL unit syntax (`5 '%'`, `29 'weeks'`, `= 1`) rather than helper-name predicates. Mutations may target either the literal value or the comparator.
