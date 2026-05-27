# Evaluating AI Agent Conformance to WHO SMART Guidelines CQL

**Status:** Draft v0 — for discussion
**Owner:** Ari Aye (Gates Foundation)
**Last updated:** 2026-05-27

---

## 1. Executive summary

The WHO SMART Guidelines program publishes Digital Adaptation Kits (DAKs) whose computable layer (L3) is authored in HL7 Clinical Quality Language (CQL). As AI coding agents become routine collaborators on clinical-logic authoring, there is no established way to measure whether a given agent produces, modifies, or reasons about CQL *correctly* against WHO's own conformance expectations.

This plan proposes an open evaluation harness that:

1. Grades agent outputs by **executing CQL** against curated patient panels (not by string similarity), using `cqframework/cql-execution` as the in-memory engine.
2. Defines a **tiered grader stack** (style → parse → type → execute → measure → semantic) so failures are diagnosable rather than opaque.
3. Ships a **task taxonomy** spanning authoring, modification, comprehension, and adversarial reasoning — including tasks (e.g. detecting inconsistencies between L2 narrative, L2 decision tables, and L3 CQL) that humans currently do not scale to.
4. As a side-effect, delivers WHO an **assertion mechanism their pipeline does not currently have** — today's `examples.yaml` files encode expected outputs as free-text comments rather than machine-checked values.

The v0 slice targets a single decision table (`IMMZD2DTMeaslesLowTransmissionLogic` in `smart-immunizations`) end-to-end, in roughly two weeks.

---

## 2. Background

### 2.1 What WHO SMART Guidelines provide

WHO publishes guidelines as a layered stack:

- **L1** — narrative (PDF/HTML).
- **L2** — structured operational artifacts (decision tables, indicator definitions, data dictionaries) authored in Excel "DAK" workbooks.
- **L3** — computable artifacts: FHIR R4 profiles, ValueSets, PlanDefinitions, Measures, and CQL libraries. Published as FHIR Implementation Guides on `smart.who.int`.

The L3 CQL Standard Operating Procedure (`smart.who.int/ig-starter-kit/v1.0.0/l3_cql.html`) prescribes:

- `using FHIR version '4.0.1'` in every library.
- A fixed library-role naming pattern: `{Prefix}Concepts`, `{Prefix}Common`, `{Prefix}Config`, `{Prefix}Elements`, `{Prefix}EncounterElements`, `{Prefix}IndicatorElements`, and one logic library per decision table (e.g. `IMMZD2DTMeaslesHighTx.cql`).
- A required tagging vocabulary: `@input`, `@pseudocode`, `@output`, `@guidance`, `@dynamicValue`, `@DecisionID`, `@BusinessRule`, `@Trigger`, `@Description`.
- A "definition of done" stating that **test cases shall exist and shall pass**, with one test resource per decision-table row.

Representative production DAKs: `smart-immunizations`, `smart-anc`, `smart-hiv`, `smart-dak-tb`, `smart-base` (shared profiles).

### 2.2 The problem

AI agents already author and modify CQL in research and pilot contexts. There is no public benchmark to answer:

- Does an agent's CQL **compile** under the WHO toolchain?
- Does it **behave** correctly against the same test patients WHO's authors used?
- Does it follow WHO's **naming, tagging, and library-role conventions**?
- Can it **reason** about CQL — detect contradictions between layers, predict outputs, suggest missing test cases?

Without this, claims of "AI assistance for clinical guideline implementation" are unverifiable.

### 2.3 What WHO actually ships today (current state of conformance)

Findings from inspection of `WorldHealthOrganization/smart-immunizations` and the L3 CQL SOP:

- **Build-time validation** is real: the HL7 IG Publisher runs the CQL→ELM translator on every `.cql` in `input/cql/`, embeds the ELM, and surfaces translator errors in `qa.html`. This is a compile gate, not behavior testing.
- **Test scaffolding is bespoke.** `input/tests/measures/<Measure>/examples.yaml` and `input/tests/plandefinition/<PD>/<PD>.yaml` use a WHO-specific YAML shorthand with relative dates (`birth: -12m`, `b+6w`) that `tools/node/makeExample.js` expands into per-resource FHIR JSON files.
- **Expected outputs live in comments.** Expected results are written as YAML comment lines (`### Client is due for MCV1`) — not machine-readable fields. There is no JS test runner in `tools/node/`.
- **Assertions actually happen elsewhere.** `processDAK.js` generates Karate `.feature` files that POST to a live FHIR server's `PlanDefinition/<id>/$apply` and assert on `response.contained`. A parallel CQL `Test Validation` define is also generated per table but nothing in the repo executes it.
- **No prior LLM-on-CQL benchmark found.** This is a green field.

The headline implication: **WHO's "test cases shall pass" requirement is partly aspirational today.** A harness with real execution-based grading both enables agent evaluation *and* upgrades WHO's own conformance pipeline.

---

## 3. Goals and non-goals

### 3.1 Goals

- **G1.** Score AI agents' CQL authoring, modification, and comprehension against WHO L3 conformance, with diagnosable per-tier failures.
- **G2.** Produce a reusable, hermetic test harness that runs offline (no live FHIR server required) and is deterministic across reruns.
- **G3.** Publish machine-readable expected-output assertions for WHO test scenarios — usable both for the eval and as a contribution back to WHO.
- **G4.** Build an adversarial task subset that is resistant to training-data contamination from the public WHO repos.
- **G5.** Cover at least one production decision table end-to-end in v0; demonstrate a path to broader coverage.

### 3.2 Non-goals

- **N1.** Replicating the full `PlanDefinition/$apply` runtime (the Karate flow). Defer to a later phase if needed.
- **N2.** Acting as a general-purpose clinical-quality-measure benchmark (CMS eCQMs, etc.) — scope is WHO SMART Guidelines.
- **N3.** Building a new CQL engine. Use `cqframework/cql-execution` (JS) as primary, optionally cross-check against the JVM engine for engine-bug discovery.
- **N4.** Auto-generating new DAK content from L1 narrative — this is *evaluation*, not authoring.
- **N5.** Replacing WHO's publication pipeline. The harness is additive.

### 3.3 Success criteria for v0

1. One decision table (Measles Low Transmission) is fully covered: all rows have machine-readable expected-output assertions and pass under the harness against the reference WHO CQL.
2. The harness runs in < 60 seconds for the full table on a laptop, with no external services.
3. A frozen baseline run exists for ≥ 2 named frontier agents on tasks drawn from each taxonomy category (B1, B2, B3, B5).
4. A PR is open against `smart-immunizations` adding the harness as `tools/node/runTests.js` plus augmented YAMLs.

---

## 4. Proposed approach

### 4.1 Conformance contract — choose expression-grading

Two viable contracts exist. We pick **expression-grading** for v0.

| | Expression-grading (cql-execution) | Apply-grading (server-based) |
|---|---|---|
| What's asserted | Named CQL define returns expected value per patient | `$apply` response contains expected CarePlan/Communication |
| Engine | `cql-execution` + `cql-exec-fhir`, in-memory | FHIR server (HAPI / CQF Ruler) |
| Hermetic? | Yes | No |
| Faithfulness to WHO | Matches the `Test Validation` define convention | Matches the published Karate `.feature` flow |
| Catches | Logic correctness in CQL | Logic + PlanDefinition wiring + extensions |
| Signal for agent eval | Sharp, per-expression | Coarse, mixes CQL bugs with packaging bugs |

Apply-grading is added later as Tier-5 where it offers independent signal.

### 4.2 Grader tiers

Every task is scored across all applicable tiers; tiers are reported separately, not collapsed to a single number.

- **T0 Style.** Library naming, required `@`-tags present, `version` element absent, file layout matches WHO conventions. Cheap regex/AST checks.
- **T1 Parse.** `cql-to-elm` translator exits clean. ELM diff vs reference is informational only.
- **T2 Type.** FHIR R4 model resolution succeeds; ValueSet/CodeSystem bindings resolve.
- **T3 Execute.** Run candidate ELM and reference ELM through `cql-execution` over the patient panel; compare expression outputs per patient. **Load-bearing tier.**
- **T4 Measure.** For indicator libraries, run `cqf-tooling` or CQF Ruler `$evaluate-measure`; diff `MeasureReport.group.population` counts.
- **T5 Semantic.** LLM-judge over `@guidance` / `@pseudocode` prose. Gated behind T0–T4 to prevent unfounded credit.

### 4.3 Harness architecture

```
┌─ Task bank (per decision-table row, per DAK)
│   authoring, modification, comprehension, adversarial
│
├─ Reference corpus (frozen at commit SHA)
│   smart-immunizations, smart-anc, smart-hiv, smart-tb
│   + augmented YAMLs with machine-readable `expected:` blocks
│
├─ Agent runner
│   candidate agents called with task spec + DAK context
│   produces: .cql file(s), test YAML, prose, or expected-block
│
├─ Graders (T0–T5)
│   T3 = cql-execution over assembled FHIR Bundles
│   T4 = $evaluate-measure for indicator libraries
│
├─ Patient panel
│   YAML → FHIR Bundle via faithful port of makeExample.js
│   + adversarial patients (B5)
│
└─ Reporting
    per-task tier results, per-DAK coverage %, per-agent tiered score,
    adversarial-subset headline, regression vs prior run
```

### 4.4 Task taxonomy

#### B1. Authoring (model produces CQL or FHIR)

| ID | Task | Output | Primary graders |
|---|---|---|---|
| A1 | Author Logic CQL from L2 decision table | `*.cql` Logic library | T0, T1, T2, T3, T4 |
| A2 | Author `Elements`/`EncounterElements` helpers from a data dictionary | `*Elements.cql` | T0, T1, T2, T3 |
| A3 | Author `Test Validation` define for a Logic library | CQL case-statement | T1, T3 |
| A4 | Author a test patient YAML for a given decision-table row | YAML doc | T0, T3 (closed-loop) |
| A5 | Author the `expected:` block for an existing YAML scenario | YAML expected: block | T3 |
| A6 | Author an `IMMZIND*Logic` indicator measure from an L2 definition | Measure + Library CQL | T1, T2, T4 |

#### B2. Modification

| ID | Task | Graders |
|---|---|---|
| M1 | Patch CQL to match a guideline diff (vN → vN+1) | T1, T2, T3 bidirectional |
| M2 | Backport a fix from one DAK to another | T3 cross-DAK |
| M3 | Add a contraindication path | T0 (DE161 pattern), T3 |
| M4 | Refactor duplicated expressions into `IMMZCommon` | T1, T3 semantics-preserving |
| M5 | Migrate a library from FHIR R4 to R5 | T1, T2 against R5 model |

#### B3. Comprehension and safety

| ID | Task | Graders |
|---|---|---|
| C1 | Explain a CQL expression mapped to `@guidance` | T5 gated by T3 round-trip |
| C2 | Detect inconsistency between L2 narrative, L2 decision table, and L3 CQL | Recall/precision on synthetic bug-injection dataset |
| C3 | Identify which test patients exercise a given row | Exact match against ground truth |
| C4 | Predict the output of a Logic library on a YAML patient *without executing it* | T3 compares prediction to actual execution |
| C5 | Suggest test cases that expose a stated weakness | T3 against a held-out buggy library |

C2 is the highest-leverage task for WHO — humans do not scale to cross-layer auditing across the DAK catalog.

#### B4. Cross-cutting structural

| ID | Task | Graders |
|---|---|---|
| S1 | Identify missing WHO tags in a CQL fragment | Set-match |
| S2 | Rename a library per WHO conventions given its role | AST match |
| S3 | Identify the correct library for a stray expression | Multiple choice |
| S4 | Translate L2 pseudocode into a `@pseudocode:` annotation | T5 + T3 round-trip |

#### B5. Adversarial subset (resistant to training-data contamination)

- **B5a Boundary patients** — sit on every threshold edge (`b+6w` exact, last-vaccine-window edge).
- **B5b Distractor data** — extra unrelated Immunizations/Conditions that should not affect output.
- **B5c Code-system swap** — same vaccine via ICD-11 MMS vs SNOMED vs DAK CodeSystem; must work via ValueSet binding.
- **B5d Time-shifted reruns** — same case at two `today` values, assert birth-anchored outputs are identical.
- **B5e Counterfactual decision tables** — synthetic tables WHO has not published, structurally similar to real ones; tests generalization vs memorization.

### 4.5 Scoring rubric

- **Tier-weighted, not collapsed.** T3-pass with T0-fail is a different failure mode than T0-pass with T3-fail; both must remain visible.
- **Per-DAK coverage %** alongside pass rate. Pass rate without coverage is misleading.
- **Headline adversarial-subset score** separate from the main score. Most resistant to contamination.
- **Tier-1-only "fast mode"** for continuous evals; full T0–T5 for release-gating.

---

## 5. Workplan

### Phase 0 — v0 slice (≈ 2 weeks)

Target: `IMMZD2DTMeaslesLowTransmissionLogic` end-to-end.

| File | Purpose |
|---|---|
| `harness/yaml_to_bundle.ts` | Faithful port of `makeExample.js` (`shiftDate` grammar with `b`/`n` anchors and `[whdmy]` units; `doses:` regex `/([bps0])(\d?)/`; `contraindication:` → `Observation` with `DE161`; deterministic `<local>-<patient>` id scheme) |
| `harness/load_bundle.ts` | Per-resource JSON folder → FHIR Bundle |
| `harness/compile_cql.ts` | Wraps `cql-to-elm.jar`, caches by content hash |
| `harness/expected_schema.ts` | TS schema for the new `expected:` YAML block |
| `harness/run_case.ts` | Runs `cql-execution` over a Bundle with `Today`/`EncounterId` overrides; returns per-define results |
| `harness/backfill_expected.ts` | Scrapes `### …` comments and `Test Validation` case-statements into draft `expected:` blocks |
| `harness/report.ts` | JUnit + JSON output, per-tier breakdown |
| `tests/IMMZD2DTMeasles*.yaml` | WHO YAMLs augmented with `expected:` |

Exit criteria: success criteria 1–2 from §3.3 met.

### Phase 1 — coverage expansion (≈ 4 weeks)

- Port remaining `smart-immunizations` decision tables.
- Add T0/T1/T2 across all of `smart-anc`, `smart-hiv`, `smart-dak-tb`.
- Build the B5 adversarial set for Measles + 2 ANC decisions.
- First baseline runs against named frontier agents; publish numbers.

### Phase 2 — comprehension tasks + LLM-judge (≈ 4 weeks)

- Implement C1, C2, C4 tasks with synthetic bug-injection datasets.
- Stand up the T5 LLM-judge with gating on T3.
- Add T4 measure-evaluation against `cqf-tooling`.

### Phase 3 — apply-grading + cross-engine (≈ 4 weeks)

- Add Tier-5 apply-grading using a containerized CQF Ruler.
- Cross-check `cql-execution` (JS) against JVM `clinical-reasoning`; surface engine disagreements as findings.

### Phase 4 — contribution and adoption

- PR the harness + augmented YAMLs to `WorldHealthOrganization/smart-immunizations`.
- Propose `expected:` block as a YAML convention in the L3 CQL SOP v2.
- Publish public leaderboard with adversarial-subset headline.

---

## 6. Sharp edges and risks

- **`makeExample.js` line ~254 bug** — `immunization.expirationDate - shiftDate(...)` (stray `-` instead of `=`) silently no-ops. Fix in the port; flag any behavioral difference in a regression test.
- **Non-deterministic dates.** Any test using `+Nd` / `-Nd` / `0d` (no `b` anchor) re-anchors to wall-clock today. Harness must pass an explicit per-doc `today` parameter and override the CQL `Today` parameter accordingly.
- **`EncounterId` CQL parameter** is auto-generated into every Logic library, but `makeExample.js` emits no Encounter resource. Pass `null` and rely on Patient context. The "EncounterElements" libraries are misnamed for the immunizations DAK.
- **`protocolApplied.series` is a free-text string.** `IMMZCommon.seriesPrimary()` matches the literal `"Primary series"`. If upstream changes this to a `Coding`, every test silently flips. Pin `smart-base`/`IMMZCommon` to a commit SHA.
- **Two L3 CQL SOP versions exist** (v1.0.0 and current at `smart.who.int/ig-starter-kit/l3_cql.html`). Confirm which the target DAK follows before pinning conventions.
- **Training-data contamination.** All target repos are public and likely in pretraining corpora for major models. The B5 adversarial subset is the only credible defense; it must be authored without an LLM in the loop.

---

## 7. Open questions

1. Which patient-panel source-of-truth do we commit to long-term: AHRQ `cql-testing` YAML format (mature, documented) or the augmented WHO YAML format (faithful to how WHO publishes)? v0 uses the latter; a Phase 2 decision should choose.
2. Does WHO want the harness contributed back, or kept external? Affects how aggressively we push for an `expected:` convention upstream.
3. What is the agent-runner protocol? File-system handoff, a thin API, or directly via tool-using agents? v0 should pick one minimal contract.
4. Funding/hosting for a public leaderboard, if Phase 4 proceeds.
5. Cross-DAK coverage priority order after Measles — ANC (most-deployed) vs HIV (most-complex) vs TB (most-actively-updated)?

---

## 9. Repository strategy

### 9.1 Layout

Three components, kept deliberately separate.

**`who-cql-agent-eval` (public)** — the eval as a product.

- Owns: task definitions for B1–B4, T0–T5 graders, YAML→Bundle port, agent-runner contract, scoring + reporting, baseline runs against named agents.
- Imports WHO DAKs as **git submodules pinned to specific commit SHAs**, never `main`. Bumping a submodule is a deliberate PR with a regression-triage report attached.
- Imports `cqframework/cql-execution`, `cql-to-elm`, and (later) `clinical-reasoning` via package managers, version-pinned.
- License: permissive (Apache-2.0) so WHO and other guideline bodies can vendor pieces back.

**`who-cql-agent-eval-adversarial` (private)** — the held-out set.

- Owns: B5a (boundary patients), B5b (distractor data), B5c (code-system swaps), B5d (time-shift cases), B5e (counterfactual decision tables).
- Explicit access list, no mirrors permitted.
- Aggregate result publication is allowed; the patient bundles, expected outputs, and counterfactual decision tables themselves are not.

**Upstream PRs into `WorldHealthOrganization/smart-*`** — contributions, not deliverables.

- The `expected:` YAML block schema.
- Augmented test YAMLs for already-published DAKs.
- Optionally: a Node test runner (`tools/node/runTests.js`) WHO can adopt.
- These flow at WHO release cadence and through WHO governance. The eval does not block on them.

### 9.2 Contamination policy for B5

The single largest threat to eval credibility is that public WHO repos are almost certainly in the pretraining corpus of every frontier model — and will be more so each year. The B1–B4 corpus therefore measures recall as much as reasoning. B5 exists to measure reasoning alone, and that property must be defended explicitly.

Rules:

- **No B5 artifact is ever committed to a public repo, posted to a public forum, included in a public dataset, or pasted into a public LLM chat.** Authoring happens in private editors and in tools with no training-data ingestion.
- **No LLM is in the loop while authoring B5.** Hand-authored only. LLM assistance during authoring biases the set toward what LLMs find easy.
- **Result publication ≠ data publication.** Aggregate scores can be published; individual cases, expected outputs, or patient bundles cannot.
- **Rotation.** A portion of B5 is "burned" — made public and retired from active scoring — on a 12-month cadence, replaced with newly authored cases. This both deters tacit memorization and produces a public reference set for replication studies.
- **Access reviews** at each rotation cycle. Adding an organization's evaluation team ≠ adding their model providers.
- **Run isolation.** Agent runs on B5 happen without outbound network access where the runner allows it, and use providers with zero-retention agreements where available. Score artifacts and trace logs are sanitized before leaving the private environment.

A B5 case is considered burned if any of: it has been published; it appears verbatim in a model's training data; or the harness operator has reasonable belief that either has occurred. Burned cases are removed from active scoring immediately.

### 9.3 Upstream-PR strategy

What is PR-able to WHO vs what stays in the eval repo:

| Artifact | Lives in | Upstream-able? |
|---|---|---|
| `expected:` YAML block schema | eval repo first, then proposed as L3 CQL SOP v2 convention | **Yes** — highest-value contribution |
| Augmented `examples.yaml` files | eval repo (as a patch over submodule) | **Yes** — per-DAK PRs |
| Node test runner `tools/node/runTests.js` | eval repo | Yes, if WHO indicates appetite; otherwise keep external |
| YAML→Bundle port of `makeExample.js` | eval repo | Maybe — if it stays a clean superset, propose replacing the original; otherwise translate at the harness boundary |
| Task definitions B1–B4 | eval repo | **No** — methodology, not WHO conformance |
| Graders T0–T5 | eval repo | **No** — same reason |
| B5 adversarial set | private repo | **No** — would defeat its purpose |

PR sequencing:

1. **PR-0 (RFC issue), early.** A non-binding issue against `smart-immunizations` introducing the `expected:` convention and the harness's intent. Establishes the channel and surfaces objections before code lands.
2. **Land Phase-0 work in the eval repo first.** A working harness with one fully-covered DAK is a stronger PR than a half-finished spec.
3. **PR-1: `expected:` blocks on existing Measles YAMLs.** Smallest, highest-value, zero behavior change to the WHO build.
4. **PR-2: Node test runner**, only if PR-0 discussion indicated appetite.
5. **PR-3+: per-DAK augmentation** rolled out as separate PRs against each DAK repo, not bundled.

Governance considerations:

- WHO contributions go through the Digital Health and Innovation team and the relevant DAK working groups. Cadence is months, not weeks. Plan around it; do not block eval work on it.
- The eval repo's pinned submodule SHAs are the contract. When WHO merges a PR, bumping the submodule + re-running baselines is a single eval-repo PR with the regression report attached.
- If WHO declines a contribution, the eval repo keeps it as a local patch indefinitely. The eval does not depend on WHO acceptance.

---

## 10. References

- WHO L3 CQL SOP v1.0.0: <https://smart.who.int/ig-starter-kit/v1.0.0/l3_cql.html>
- WHO L3 CQL SOP current: <https://smart.who.int/ig-starter-kit/l3_cql.html>
- smart-immunizations: <https://github.com/WorldHealthOrganization/smart-immunizations>
  - `tools/node/makeExample.js`, `tools/node/processDAK.js`
  - `input/tests/measures/`, `input/tests/plandefinition/`
- smart-base: <https://github.com/WorldHealthOrganization/smart-base>
- `cqframework/cql-execution`: <https://github.com/cqframework/cql-execution>
- `cqframework/cqf-tooling`: <https://github.com/cqframework/cqf-tooling>
- AHRQ CQL Testing Framework: <https://github.com/AHRQ-CDS/CQL-Testing-Framework>
- HL7 Using CQL with FHIR IG: <https://build.fhir.org/ig/HL7/cql-ig/using-cql.html>
- HL7 CQF Measures packaging: <https://build.fhir.org/ig/HL7/cqf-measures/packaging.html>
