# Substrate Freeze

**Applies to:** the seven governance-staging substrates merged
through GM-29, the eight Decision-gated actor factories exported
by `src/actors/index.js`, the nineteen ctx operations exposed by
`withReviewContext(...).ctx`, and the locked vocabulary
snapshots (`INTENT_TYPES` = 14, `REASONS` = 17, `OUTCOMES` = 10,
`EVENT_TYPES` = 2, `EXECUTION_OUTCOME_TYPES` = 4 / `reported_*`,
`VERIFICATION_TYPES` = 4, `VERIFICATION_RESULTS` = 3 /
`verified_*` constitutionally isolated).

**Status:** locked at GM-30. The freeze is the central
architectural property of GM-30 and is mechanically asserted by
the L22 substrate-freeze canary in
`tests/governance/adversarial.test.js`. Bumping any of the
locked counts requires a NEW inspection-only GM with its own OQ
approval block, paired updates to this document, and a paired
update to L22.

**Verbatim constitutional phrase** (L27-enforced — also appears
verbatim in `docs/deployment/release-candidate.md`):

> No new substrate without an inspection-only GM

**Depends on:** all seven prior substrate runtime-boundary docs
(`review-queue-runtime-boundary.md` through
`execution-verification-runtime-boundary.md`),
`gauntlet-harness.md` (the test harness that proves the
substrate holds under adversarial input).

## Purpose

GM-23 through GM-29 built the seven-stage governance chain —
propose → review → authorize → claim → attempt → outcome →
verification. Each stage was added under its own inspection-only
GM with its own OQ approval block, its own constitutional
addenda, its own boundary-guard extension, its own adversarial
test series, and its own paired-doc updates. Each stage added a
new mechanical defense — a new table, a new actor, a new
trigger, a new canary.

The substrate is now broad enough to test against. **Continuing
to add substrate before testing the substrate is the failure
mode this freeze exists to prevent.** GM-30 builds the
adversarial gauntlet harness; GM-31+ must START by extending the
adversarial coverage of the existing substrate before any new
substrate addition is even inspected.

## What is frozen

Mechanically enforced by L22:

| Property | Locked count | Where snapshot lives |
|---|---|---|
| Governance-staging tables | **7** — `governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations`, `governance_execution_claims`, `governance_execution_attempts`, `governance_execution_outcomes`, `governance_execution_verifications` | L22 scans `db/migrations/0NN_*.sql` filenames |
| Decision-gated actor factories | **8** — `createResponseDeliveryActor`, `createReviewQueueActor`, `createReviewDecisionActor`, `createExecutionAuthorizationActor`, `createExecutionClaimLedgerActor`, `createExecutionAttemptLedgerActor`, `createExecutionOutcomeLedgerActor`, `createExecutionVerificationLedgerActor` | L22 scans `src/actors/index.js` exports |
| ctx operations | **19** — exposed by `withReviewContext(pool, ctx, fn)` | L22 scans `src/review/transaction.js` |
| `EVENT_TYPES` | **2** — `memory.created`, `memory.list` | L22 + L15 read `src/memory/audit.js` |
| `INTENT_TYPES` | **14** | C3 snapshot |
| `REASONS` | **17** | C2 snapshot |
| `OUTCOMES` (actor outcomes) | **10** | C4 snapshot |
| `EXECUTION_OUTCOME_TYPES` | **4**, all `reported_*` prefixed | J37 snapshot |
| `VERIFICATION_TYPES` | **4** channel values | K37 snapshot |
| `VERIFICATION_RESULTS` | **3**, with `verified_*` constitutionally isolated | K37 snapshot + K37 `verified_*` isolation assertion |
| RLS policies | 18 across the 7 staging tables (2 each) + the prior memory / vault / circle policies | unchanged from GM-29 |
| GRANTs to `lylo_app` / `lylo_admin` | inherited unchanged from GM-29 | unchanged |

## What is not frozen

GM-30 and any future inspection-only GM may freely:

- Add **gauntlet scenarios** under `tests/gauntlet/scenarios/`
  (versioned, CI-blocking) without a new substrate decision
  gate. Adding a scenario is a paired-change with the runner
  test, nothing more.
- Add **integration tests** under `tests/integration/`,
  **adversarial probes** under `tests/governance/adversarial.test.js`,
  **rls-contract scenarios** under `tests/rls-contract/`.
- Improve **documentation** under `docs/`.
- Extend the **gauntlet harness** under `src/gauntlet/` — new
  forgery patterns, new fixture helpers, new trace stages —
  **as long as the L24 forbidden vocabulary scan and the
  check-gauntlet-boundary.js import allowlist continue to
  pass**. Adding new gauntlet capability is NOT a substrate
  change.
- Add **new categories** to `SCENARIO_CATEGORIES` if a new kind
  of adversarial probe is identified, paired with an L37
  snapshot bump and a paired-PR scenario authoring under
  `tests/gauntlet/scenarios/`.
- Fix **bugs** in existing substrate code without paired-OQ
  approval — but bug fixes that touch CHECK constraints, RLS
  policies, GRANTs, or vocabulary snapshots are substrate
  changes by definition and ARE subject to the freeze.

## How to unfreeze

Adding a new substrate table, a new actor factory, a new ctx
operation, a new `EVENT_TYPES` entry, a new `INTENT_TYPES`,
`REASONS`, or `OUTCOMES` value, or a new locked vocabulary
requires a new inspection-only GM (let's call it GM-NN). The
process:

1. Owner posts a GM-NN inspection request enumerating exactly
   what would unfreeze and why.
2. The inspection produces an OQ-NN.x decision matrix.
3. Owner approves each OQ explicitly.
4. Implementation lands the new substrate paired with:
   - the substrate's own runtime-boundary doc (with the four
     mandatory K27-style sections),
   - the substrate's own adversarial canary series,
   - the substrate's own boundary-guard extensions,
   - the substrate's own RLS contract extensions,
   - the substrate's own integration test,
   - **a paired L22 update bumping the substrate-freeze
     count(s) to reflect the new substrate, with a paired
     update to THIS document's "What is frozen" table.**
5. The substrate freeze is RE-locked at the new count. The
   freeze itself never goes away; only the specific count
   shifts.

A silent count bump — code lands new substrate but L22 is not
updated — fails CI immediately. The freeze is not a
gentleman's agreement; it is a mechanical constraint with a
canary.

## Why this exists

Six prior GMs added substrate at a steady cadence: each one
introduced new vocabulary, new triggers, new constraints, new
canaries. The cadence proved that the architectural pattern is
sound. It also proved that **without an explicit stop**, the
substrate will keep growing because each new substrate is
locally well-motivated.

The gauntlet harness exists because the substrate is now wide
enough that adversarial coverage is the bottleneck, not
substrate breadth. Continuing to add substrate without first
exhaustively testing the substrate that already exists is the
failure mode this freeze prevents:

- Each new substrate adds new attack surface.
- Each new substrate adds new vocabulary to police.
- Each new substrate adds new chain-walk depth.
- Each new substrate adds new separation-of-duties stages,
  inflating fixture cardinality and increasing the cost of
  exhaustive integration testing.

**No new substrate without an inspection-only GM.** When the
council can show that the existing seven substrates withstand a
comprehensive adversarial gauntlet across every category — when
every L-series, K-series, J-series, I-series, H-series,
G-series, F-series, and E-series probe is green and the
gauntlet has ingested every adversarial probe the council can
think of — then a new substrate decision gate is welcome.
Until that bar is met, the freeze holds.

## Change control

Locked. Any change to the locked counts in "What is frozen" is
a reviewed change to:

- this document,
- `tests/governance/adversarial.test.js` (L22 + any
  series-specific snapshot),
- the relevant `runtime-boundary.md` doc,
- `docs/deployment/release-candidate.md` (the substrate-freeze
  callout must be updated to reflect the new count),
- `docs/governance/baseline-ci.md` (the boundary-guard rows
  must reflect the new substrate or actor),
- `db/migrations/README.md` if a new migration lands,
- the relevant source files for the new substrate.

The verbatim phrase **`No new substrate without an
inspection-only GM`** must remain in this document AND in
`docs/deployment/release-candidate.md`. L27 enforces.

## Cross-references

- `gauntlet-harness.md` — the test harness this freeze enables.
- `actor-runtime-boundary.md` — the 8 Decision-gated actors.
- `governance-runtime-boundary.md` — the classifier vocabulary.
- `rls-privacy-contract.md` — the 7 staging tables.
- `baseline-ci.md` — the 14 boundary guards (including the new
  `check-gauntlet-boundary.js`).
- `../deployment/release-candidate.md` — the operator-facing
  freeze callout.
- `../../tests/governance/adversarial.test.js` — L22 (freeze
  canary), L15 (EVENT_TYPES), L24 (gauntlet vocab), L27 (this
  doc-presence canary), L37 (gauntlet vocab snapshot), L38
  (manual-mode refusal).
- `../../tests/gauntlet/` — the harness's versioned scenarios
  and manual-mode landing zone.
