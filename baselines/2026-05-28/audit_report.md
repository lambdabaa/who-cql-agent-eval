# Audit-mode results (2026-05-28)

The audit task points each agent at one **real, unmodified** WHO Logic
library and its L2 brief. There is no truth file: any flagged finding is
either a transcription error in the brief, a model false positive, or a
real L2↔L3 inconsistency hiding in the WHO content.

## Headline

Across 4 agents × 5 libraries = **20 audit runs, 0 findings reported**.

| Library                                             | Opus 4.7 | Haiku 4.5 | GPT-5.5 | GPT-5.4-nano |
|-----------------------------------------------------|----------|-----------|---------|--------------|
| `IMMZD2DTMeaslesLowTransmissionLogic`               | clean    | clean     | clean   | clean        |
| `IMMZD2DTMeaslesMCVDose0Logic`                      | clean    | clean*    | clean   | clean        |
| `IMMZD2DTMeaslesOngoingTransmissionLogic`           | clean    | clean     | clean   | clean        |
| `IMMZD2DTMeaslesSupplementaryDoseLogic`             | clean    | clean     | clean   | clean        |
| `ANCDT08`                                           | clean    | clean     | clean   | clean        |

*Haiku 4.5 on MCV0 emitted a chain-of-thought response with two JSON
blocks, neither tagged `path=findings.json`; the runner's output parser
recorded "no submission". The model's final conclusion in the raw
response was `{"findings": []}`, consistent with the others.

## Interpretation

Two non-trivial readings of this result:

**1. The agents do not invent bugs against clean content.**
With a prompt that explicitly warns "do not invent inconsistencies, the
library is real production CQL," all four agents (including
`gpt-5.4-nano`, which has a ~25% false-positive rate on the C2 detection
task) returned empty findings on every library. The audit-mode prompt
shape is robust against hallucinated bugs at the frontier level — and
even at the small-model level — when the prior is set correctly.

**2. The methodology can't find real bugs in this configuration.**
The L2 briefs used here were transcribed by the harness authors *from*
the published CQL annotations (the `@output`, `@guidance`, `@pseudocode`
tags in each Logic library). A library that perfectly matches its own
docstrings is the expected default, so the upper bound on real findings
this audit can produce is "bugs in the harness author's transcription"
— effectively zero, since the briefs were reviewed against the CQL at
write-time.

To actually surface latent L2↔L3 inconsistencies in WHO content, the L2
brief must come from a source **independent of the L3 CQL**:

- the L2 Excel workbook in `smart-immunizations` (or its rendered HTML
  at `smart.who.int`), or
- the L1 narrative for each decision table.

Without that independent source, audit-mode produces only one numeric
signal: the per-agent false-positive rate on known-clean content. That
rate is 0/5 across all four agents here — useful as a sanity check
before deploying audit-mode against real workflows.

## Next iteration

To make audit-mode produce candidate bugs, the next bite is to source
briefs from `smart.who.int`'s published HTML decision-table pages (or
from the input/l2/ Excel files where present in the upstream repo).
Holding the L3 CQL constant and varying the brief source is the
critical experiment — same agent prompts, same harness, but a brief
the L3 author didn't see when writing the library.

## Reproducibility

- Fixtures: `tasks/audit_*/`
- Per-agent runs: `runs/<agent>/audit_*/` (gitignored; see `outputs/findings.json` and `grade.json`)
- Per-task grade summaries: aggregated in `baselines/2026-05-28/summary.json`
- Re-run with `npx tsx src/cli.ts baseline run --agent <provider:model> ...`
