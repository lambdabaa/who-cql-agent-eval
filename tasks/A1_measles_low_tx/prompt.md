# Task A1: Author Measles Low Transmission Logic CQL

You are authoring one CQL Logic library for the WHO SMART Guidelines IMMZ
(Immunizations) DAK against the **L3 CQL SOP**. Output a single file:
`IMMZD2DTMeaslesLowTransmissionLogic.cql`.

## What to read

- `inputs/L2_table.md` — the decision table (rows, preconditions, output
  define names, guidance strings).
- `inputs/deps/IMMZD2DTMeaslesEncounterElements.cql` — the dependency
  library exposing the `Encounter.<define>` helpers your preconditions
  reference. You may also rely on `FHIRHelpers` being available.

## Required conventions (WHO L3 CQL SOP)

- `library IMMZD2DTMeaslesLowTransmissionLogic` (no `version` clause).
- `using FHIR version '4.0.1'`.
- `include FHIRHelpers version '4.0.1'`.
- `include IMMZD2DTMeaslesEncounterElements called Encounter`.
- `parameter Today Date default Today()`.
- `context Patient`.
- Every boolean output define gets an `@output:` annotation in a JSDoc-style
  `/* ... */` comment block immediately above its `define`.
- Every guidance string define gets an `@guidance:` annotation.
- The aggregator `Guidance` define gets an `@dynamicValue: Guidance`
  annotation.

## Behavioural requirements

- Match the L2 table rows exactly — every Boolean output define listed must
  exist and evaluate to the conjunction/disjunction described.
- Guidance text must be the verbatim string in L2_table.md, with backslash-n
  rendered as a literal newline in the CQL string (use a multi-line
  single-quoted CQL string, e.g. `'first line\nsecond line'` written across
  two source lines, exactly as WHO authors do).
- Apostrophes inside guidance strings must be escaped as `\'` because CQL
  string literals are single-quoted.

## Output

Emit the file as a fenced code block tagged `path=IMMZD2DTMeaslesLowTransmissionLogic.cql`.
