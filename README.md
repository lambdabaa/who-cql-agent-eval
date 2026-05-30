# who-cql-agent-eval

[![CI](https://github.com/lambdabaa/who-cql-agent-eval/actions/workflows/ci.yml/badge.svg)](https://github.com/lambdabaa/who-cql-agent-eval/actions/workflows/ci.yml)

Evaluation harness for AI agents that author, modify, or reason about
WHO SMART Guidelines CQL. The v0 slice targets the
`IMMZD2DTMeaslesLowTransmissionLogic` decision table in
`WorldHealthOrganization/smart-immunizations`.

See [`docs/PLAN.md`](docs/PLAN.md) for the design document and rationale.
Live leaderboard: <https://lambdabaa.com/who-cql-agent-eval/>.

## Leaderboard

The static site under `docs/` is the public leaderboard, deployed via GitHub
Pages (Settings → Pages → Source: `Deploy from a branch`, branch `main`,
folder `/docs`). To regenerate the leaderboard payload after a new baseline:

```sh
npx tsx scripts/build_leaderboard.ts          # latest baseline in baselines/
npx tsx scripts/build_leaderboard.ts 2026-05-28  # a specific date
```

That sanitizes the baseline `summary.json` (strips absolute filesystem
paths) into `docs/data/<date>.json` and refreshes `docs/data/manifest.json`.

## Overview

WHO SMART Guidelines publish clinical recommendations as a layered stack: L1
narrative, L2 decision tables and data dictionaries, and L3 computable
artifacts (FHIR R4 profiles, ValueSets, PlanDefinitions, Measures, and CQL
libraries). The L3 CQL layer is the executable expression of each decision
table — and the layer AI agents are increasingly asked to author, modify, or
reason about. This harness grades agents against WHO's own conformance
expectations by **executing** their CQL against curated patient panels,
rather than scoring it by string similarity.

Background reading:

- **WHO SMART Guidelines L3 CQL SOP** — naming, tagging, and library-role
  conventions every WHO CQL library must follow:
  [v1.0.0](https://smart.who.int/ig-starter-kit/v1.0.0/l3_cql.html) ·
  [current](https://smart.who.int/ig-starter-kit/l3_cql.html)
- **`smart-immunizations`** — the production WHO immunizations DAK this v0
  slice targets:
  <https://github.com/WorldHealthOrganization/smart-immunizations>
  (vendored at `vendor/smart-immunizations/`, pinned to SHA `b16245f71`)
- **HL7 *Using CQL with FHIR* IG** — how CQL libraries bind to FHIR R4
  models: <https://build.fhir.org/ig/HL7/cql-ig/using-cql.html>
- **`cqframework/cql-execution`** — the in-memory JS CQL engine the Tier-3
  grader runs: <https://github.com/cqframework/cql-execution>
- **`cqframework/cql-to-elm`** — the Java translator the harness drives to
  produce ELM: built via `scripts/fetch_cql_to_elm.sh`
- **AHRQ CQL Testing Framework** — prior art for execution-based CQL
  testing (Karate-based, FHIR-server-backed):
  <https://github.com/AHRQ-CDS/CQL-Testing-Framework>

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| Node ≥ 20 | TypeScript harness runtime | `brew install node` |
| Git | Repo + submodule | preinstalled on macOS |
| OpenJDK 17 | Runs the CQL → ELM translator (required for Tier-3) | `brew install openjdk@17` |
| Maven 3.9+ | Assembles a runnable fat jar from cqframework's Maven Central artifacts | `brew install maven` |

After installing OpenJDK 17, expose it on `PATH` (homebrew does not symlink
JDKs by default):

```sh
echo 'export PATH="$(brew --prefix openjdk@17)/bin:$PATH"' >> ~/.zshrc
exec zsh
java -version  # should print "openjdk version \"17.x.x\""
```

## First run

```sh
git clone <this-repo> who-cql-agent-eval
cd who-cql-agent-eval
git submodule update --init                     # pull smart-immunizations at the pinned SHA
npm install                                     # JS deps for the harness
./scripts/fetch_cql_to_elm.sh                   # build cql-to-elm fat jar (~2 min first time)
npm run eval:measles                            # run the Measles Low Transmission slice
```

Reports land in `reports/`:

- `reports/report.json` — structured per-tier + per-case results, machine-readable
- `reports/junit.xml` — JUnit-flavored XML for CI integration

## What's in the box

```
src/
  cli.ts                       `who-eval run`, `who-eval backfill`, `who-eval baseline …`
  harness/
    expected_schema.ts         zod-validated `expected:` YAML block (the v0 WHO contribution)
    yaml_to_bundle.ts          port of WHO tools/node/makeExample.js, with the
                               line-254 expirationDate bug-fix gated by applyKnownBugFixes
    load_bundle.ts             JSON-tree → FHIR Bundle (fallback input path)
    compile_cql.ts             content-hashed cache around the cql-to-elm fat jar
    run_case.ts                Tier-3 grader: cql-execution over Bundles with deterministic Today
    backfill_expected.ts       scrapes ### comments + Test Validation define → draft expected: blocks
    report.ts                  per-tier JSON + JUnit output
  runners/
    types.ts                   AgentRunner interface (file-system handoff contract)
    common.ts                  prompt assembly + fenced-block output parsing
    anthropic.ts               Anthropic SDK adapter
    openai.ts                  OpenAI SDK adapter
  agent_tasks/
    schema.ts                  task.json (authoring + prediction kinds)
    build_a1.ts                A1 (author Measles Logic) fixture builder
    build_c4.ts                C4 (predict outputs) fixture builder + groundtruth capture
    grade_a1.ts                T1 + T3 grader for authoring submissions
    grade_c4.ts                cell-level diff vs groundtruth for predictions
    baseline.ts                top-level orchestration: build → run → grade → freeze
tasks/                         canonical task fixtures (regenerated by `baseline build`)
baselines/<date>/summary.json  frozen baseline runs (committed)
runs/                          per-agent run dirs (gitignored, transient)
tests/
  dak/IMMZD2DTMeaslesLowTransmissionLogic.yaml
                               WHO YAML overlay with machine-readable expected: blocks for all 7 rows
  harness/*.test.ts            unit tests
  integration/*.test.ts        end-to-end overlay-parse + T3 checks
  runners/*.test.ts            runner-contract unit tests
vendor/smart-immunizations/    git submodule pinned at SHA b16245f71
```

## Usage

### Run the Measles slice

```sh
npm run eval:measles
```

equivalent to:

```sh
npx tsx src/cli.ts run \
    --dak smart-immunizations \
    --table IMMZD2DTMeaslesLowTransmissionLogic \
    --today 2026-01-15
```

Expected output on a clean run:

```
> tsx src/cli.ts run --dak smart-immunizations --table IMMZD2DTMeaslesLowTransmissionLogic

loaded 192 ValueSets from FSH
compiled 280 libraries (hits=0 misses=279)
wrote reports/report.json
wrote reports/junit.xml

T3 execute: pass
cases: 7/7 passed
```

Flags:

| Flag | Default | Meaning |
|---|---|---|
| `--dak` | `smart-immunizations` | Subdir of `vendor/` to target |
| `--table` | `IMMZD2DTMeaslesLowTransmissionLogic` | Logic library identifier |
| `--yaml` | `tests/dak/<table>.yaml` | Augmented YAML with `expected:` blocks |
| `--today` | `2026-01-15` | Wall-clock anchor for relative dates and the CQL `Today` parameter |
| `--out` | `reports` | Output dir for `report.json` + `junit.xml` |
| `--jar` | `$CQL_TO_ELM_JAR` or `tools/cql-to-elm/cql-to-elm.jar` | Path to the fat jar |
| `--skip-compile` | — | Skip Tier-1 (parse) and rely on a warm `.cache/elm` |

### Run an agent baseline

The `baseline` family runs frontier agents against task fixtures derived from
the same Measles slice, then freezes the results to `baselines/<date>/`.

```sh
# 1. Generate canonical task fixtures under tasks/.
npx tsx src/cli.ts baseline build

# 2. Run one or more agents against every fixture. Each agent gets its own
#    sandbox under runs/<agent>/<task>/ so they don't trample each other.
ANTHROPIC_API_KEY=… OPENAI_API_KEY=… \
  npx tsx src/cli.ts baseline run \
    --agent anthropic:claude-opus-4-7 \
    --agent openai:gpt-5.5

# 3. Grade everything under runs/ and freeze a roll-up.
npx tsx src/cli.ts baseline freeze
# → wrote baselines/2026-05-27/summary.json
```

v0 ships two task kinds:

| Task | Kind | What the agent does | Grader |
|---|---|---|---|
| `A1_measles_low_tx` | authoring | Author `IMMZD2DTMeaslesLowTransmissionLogic.cql` from an L2 brief + the EncounterElements dep. | T1 (parse) + T3 (execute) over the 7 augmented patients. |
| `C4_measles_low_tx` | prediction | Predict per-define values for each patient without running the library. | Cell-level diff against captured reference T3 results. |

Re-running `baseline run` is a no-op for tasks whose `outputs/` already
exists; pass `--force` to overwrite. Each completed run drops a `run.json`
(token usage, duration, warnings) next to its `outputs/` for audit.

### Draft `expected:` blocks for a new decision table

```sh
npx tsx src/cli.ts backfill \
    --yaml vendor/smart-immunizations/input/tests/plandefinition/IMMZD18S<X>/<X>.yaml \
    --cql vendor/smart-immunizations/input/cql/<LogicLibrary>.cql
```

Prints draft `expected:` blocks to stdout — one per patient — derived from
the YAML's `### …` comments and the Logic library's `Test Validation`
case-statement. Always reviewed by a human before being merged into a
`tests/dak/<table>.yaml` overlay.

## Tier model

The grader stack is six tiers; v0 wires Tier-3 (Execute) as the
load-bearing path. Other tiers report `not-applicable` until they're built
out — see `docs/PLAN.md §4.2`.

| Tier | What it checks | v0 status |
|---|---|---|
| T0 Style | Library naming, required `@`-tags, file layout | stub |
| T1 Parse | `cql-to-elm` exits clean | implicit (compile errors surface in T3) |
| T2 Type | FHIR R4 model resolution, ValueSet bindings | stub |
| T3 Execute | Define-by-define results vs `expected:` blocks | **wired** |
| T4 Measure | `MeasureReport.group.population` counts | stub |
| T5 Semantic | LLM-judge over `@guidance` / `@pseudocode` | stub |

## Tests

```sh
npm test           # vitest: 26 tests across harness + integration
npm run typecheck  # strict TS, src + tests
npm run build      # emits to dist/ (src only)
```

## Troubleshooting

**`java: command not found`** after `brew install openjdk@17`
→ Homebrew does not symlink JDKs system-wide. Either
  `export PATH="$(brew --prefix openjdk@17)/bin:$PATH"` in your shell rc,
  or `sudo ln -sfn $(brew --prefix openjdk@17)/libexec/openjdk.jdk
  /Library/Java/JavaVirtualMachines/openjdk-17.jdk`.

**`./scripts/fetch_cql_to_elm.sh` succeeds but `java -jar … --help` errors**
with `NoClassDefFoundError`
→ Re-pull and rerun. The cqframework artifacts moved to Gradle metadata
  that the Maven pom can't fully express; the script declares the missing
  deps explicitly. If you've changed `$CQL_TO_ELM_VERSION`, you may need
  to add new deps when the upstream graph changes.

**`logic library X not present in compiled libraries`**
→ The fat jar isn't built or `tools/cql-to-elm/cql-to-elm.jar` isn't
  where the harness expects it. Run `./scripts/fetch_cql_to_elm.sh`. If
  it's elsewhere, `export CQL_TO_ELM_JAR=/path/to/cql-to-elm.jar`.

**T3 results don't match the WHO `### …` comment outcomes**
→ Confirm `--today` is the same value the YAML was authored against.
  WHO YAMLs use relative dates like `-12m` and `b+15m`; the harness
  always overrides the CQL `Today` parameter for reproducibility, but
  the YAML itself was hand-authored around a specific "today".

**`baseline run` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`**
→ Node's bundled CA store doesn't include your machine's corporate or
  intermediate CAs (common with macOS TLS-inspecting proxies). Point Node
  at the system bundle:
  `export NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem`. `curl` succeeding to the
  same host is a strong signal this is the fix.

## License

Apache-2.0. WHO DAK content vendored via submodule is governed by its
upstream license (currently Apache-2.0 on `smart-immunizations`).
