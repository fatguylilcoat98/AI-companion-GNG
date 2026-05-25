# Execution-Outcome Runtime Boundary

**Applies to:** the execution-outcome substrate (`src/review/`
repository functions `recordExecutionOutcome`,
`listExecutionOutcomes`, `inspectExecutionOutcome`; the new
`src/actors/execution-outcome-ledger-actor.js` actor; and the
`governance_execution_outcomes` table created by
`db/migrations/013_execution_outcomes.sql`). Introduced in GM-28
— the sixth persistence expansion since the process lock,
extending the GM-23/24/25/26/27 governance-staging chain with the
**first** artifact that names the apparent state an attempt
*landed in*, while explicitly refusing to name what was true.

**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, an UPDATE path, a new recorder role,
relaxing any CHECK constraint, OR widening
`EXECUTION_OUTCOME_TYPES` beyond the four `reported_*` values
requires paired updates to this document, the migration chain,
the rls-contract synthetic suite, and the adversarial snapshot
tests (C2/C3/C4/J37) plus the J-series in
`tests/governance/adversarial.test.js`. **Removing the "What
this is NOT" or "What remains unresolved" sections fails the J27
doc-presence canary.**

**Depends on:** all prior staging substrate docs
(`review-queue-runtime-boundary.md`,
`review-decision-runtime-boundary.md`,
`execution-authorization-runtime-boundary.md`,
`execution-claim-runtime-boundary.md`,
`execution-attempt-runtime-boundary.md`),
`governance-runtime-boundary.md` (classifier + Decision shape
the actor consumes), `actor-runtime-boundary.md` (actor
contract), `rls-privacy-contract.md` (engaged RLS policies).

## Purpose

GM-27 made every attempt observable: each authorized claim could
be attempted exactly once, immutably, by an admin other than the
claimant. But the chain still had no artifact at which a human
could record **what they saw happen** to that attempt — and so
"the attempt began" and "we observed an apparent end state"
would inevitably collapse into "it worked / it didn't," which
silently smuggles a truth claim the substrate is not authorised
to make.

GM-28 adds the smallest possible **observational outcome**
substrate:

- a different admin (not the attempter) can **record what they
  observed** about a recorded attempt,
- the recorded outcome is **immutable** and **append-only**,
- each attempt is record-against-able **at most once**
  (`UNIQUE(execution_attempt_id)` — replay forbidden in GM-28
  per OQ-28.4),
- a recorder **cannot record an outcome against an attempt they
  themselves initiated** (BEFORE-INSERT trigger),
- the outcome's `authorization_scope` and `execution_surface`
  must **equal** the attempt's values (drift detection — the
  recorder cannot retroactively rewrite scope or surface),
- the underlying review_decision must still be `'approved'`
  (defense-in-depth chain walk, now six layers deep).

The substrate is **inert**. It records. Nothing in GM-28 reads
outcome rows operationally, executes anything, mutates memory,
schedules background work, notifies external systems, or feeds
back into the queue / decision / authorization / claim / attempt
chain.

**Outcomes are also OPTIONAL.** No attempt is required to ever
acquire an outcome row, and the absence of an outcome row is
NOT itself an outcome. Missing outcome rows remain structurally
valid. Any policy that interprets absence is OUTSIDE the GM-28
contract.

The constitutional rule (now applied at six levels):

> **Approval is not authorization.**
> **Authorization is not execution.**
> **An authorization row is not an execution signal.**
> **A claim row is not execution — it only records single-consumption.**
> **An attempt row is not an outcome — it only records the beginning of an attempt.**
> **An outcome row is not truth — it only records what a human reported they observed.**

GM-28 records **reported observations**. It does NOT record
verified facts. `reported_completed` ≠ `verified_completed`.
Verification remains a separate future ring with separate
vocabulary, separate governance, and a separate decision gate.

## 1. Module placement

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes recordExecutionOutcome,
                       listExecutionOutcomes, inspectExecutionOutcome
                       alongside the GM-23/24/25/26/27 ops.
  repository.js      — extended: 3 new functions;
                       + VALID_EXECUTION_OUTCOME_TYPES Set (4 values, all
                         `reported_*` prefixed)
                       + VALID_RECORDER_ROLES Set (admin only).
  index.js           — public surface unchanged.

src/actors/
  outcomes.js        — + OUTCOMES.OUTCOME_RECORDED = 'outcome_recorded'
  execution-outcome-ledger-actor.js  — NEW (per OQ-28.13; "ledger"
                       in the filename is MANDATORY and is the single
                       most important architectural defense at this
                       layer against operational AND truth-claim drift).
  index.js           — + createExecutionOutcomeLedgerActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_execution_outcomes'
  - INSERT_ALLOWED_TABLES += 'governance_execution_outcomes'
  - NEW: third file-scoped forbidden-vocabulary scan, using the
    shared FILE_SCOPED_SCANS / runFileScopedForbiddenScan helper.
    Bans GM-27's 8 outcome-implying words PLUS 10 NEW truth-claim
    words in `src/actors/execution-outcome-ledger-actor.js`:
    `verified`, `confirmed`, `actual`, `actually`, `definitely`,
    `proven`, `certain`, `real`, `reality`, `truth`. This is the
    STRICTEST file-scoped scan in the entire substrate — 18 words.

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — src/governance/ widens
  vocabulary by exactly one INTENT_TYPES + one REASONS + one
  POLICY_REFS + one classifier branch. Every other module
  UNCHANGED.

docs/governance/execution-outcome-runtime-boundary.md  — NEW (this doc).
db/migrations/013_execution_outcomes.sql              — NEW.
```

## 2. Schema (`governance_execution_outcomes`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `execution_attempt_id` | UUID NOT NULL | composite FK + UNIQUE on its own |
| `authorization_scope` | TEXT NOT NULL | CHECK in GM-25's 4-value vocab; trigger asserts equality with the attempt's scope |
| `execution_surface` | TEXT NOT NULL | CHECK in GM-26's 4-value vocab (all `future_*`); trigger asserts equality with the attempt's surface |
| `outcome_type` | TEXT NOT NULL | **CHECK locked to the 4 `reported_*` values** |
| `recorded_by_user_id` | UUID NOT NULL | composite FK |
| `recorded_by_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (execution_attempt_id)` — at most one outcome per attempt |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite-FK targets |
| — | — | composite FK `(pilot_instance_id, recorded_by_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, execution_attempt_id)` → `governance_execution_attempts` |

**The `outcome_type` CHECK** is locked at the database level to
exactly four values:

- `reported_completed`
- `reported_interrupted`
- `reported_abandoned`
- `reported_unknown`

The `reported_*` prefix is a constitutional boundary, not a
naming style. It puts into the data itself the fact that the row
is an observation, not a verdict. Adding `reported_succeeded`,
`reported_failed`, or any non-`reported_*` value (e.g.
`completed`, `verified_completed`) requires the four-fold update
above AND a decision gate that explicitly addresses the
truth-claim ring.

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No RLS policy could permit the operation even if a grant were added.

**Preconditions BEFORE-INSERT trigger** walks the 6-deep chain
outcome → attempt → claim → authorization → review_decision and
enforces five invariants:

| # | Check | Catches |
|---|---|---|
| (a) | attempt exists in same pilot | nonexistent / cross-pilot reference |
| (b) | `outcome.authorization_scope = attempt.authorization_scope` | scope drift / retroactive rewrite |
| (c) | `outcome.execution_surface = attempt.execution_surface` | surface drift / retroactive rewrite |
| (d) | `attempt.attempted_by_user_id ≠ outcome.recorded_by_user_id` | self-recording |
| (e) | `review_decision.review_outcome = 'approved'` (full chain walk) | chain rot |

## 3. RLS policies

Two policies on `governance_execution_outcomes`:

- **`outcome_insert_admin`** (INSERT WITH CHECK) — tenant match
  AND `recorded_by_user_id = current_setting('app.user_id')`
  AND `current_setting('app.user_role') = 'admin'`.
- **`outcome_admin_select`** (SELECT) — tenant match AND
  `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant / attempter /
recorder-as-non-admin / family / caregiver / runtime SELECT
policy.** Outcomes are admin-only governance metadata.

**No UPDATE / DELETE policy.**

## 4. Locked vocabularies

GM-28 introduces **one** new locked vocabulary at the substrate
layer:

| Set | Where | Values |
|---|---|---|
| `EXECUTION_OUTCOME_TYPES` | `src/review/repository.js` as `VALID_EXECUTION_OUTCOME_TYPES`; mirrored in the migration CHECK | `reported_completed`, `reported_interrupted`, `reported_abandoned`, `reported_unknown` |

Inherited unchanged:

- `AUTHORIZATION_SCOPES` — from GM-25 (4 values).
- `EXECUTION_SURFACES` — from GM-26 (4 values, all `future_*`
  prefixed).
- `recorded_by_role` — CHECK-locked to `'admin'`.

The trigger asserts outcome-row scope/surface values equal the
attempt's. Any drift is caught at INSERT time.

**Why exactly these four outcome values:**

| Value | Semantic |
|---|---|
| `reported_completed` | Recorder observed the attempt reached an apparent end without obvious interruption. NOT a success claim. |
| `reported_interrupted` | Recorder observed the attempt stopped before its apparent end. NOT a failure claim. |
| `reported_abandoned` | Recorder observed the attempt was never carried further by the responsible human. NOT a fault claim. |
| `reported_unknown` | Recorder explicitly records active epistemic uncertainty — they do not know. NOT a default filler state; it is an affirmative observation that information was sought and not obtained. |

`reported_succeeded` and `reported_failed` are deliberately
excluded: success/failure are truth claims, and the
truth-claim ring is a separate future GM with its own gate.

## 5. Public API surface (post-GM-28)

| Export | Status |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes **sixteen** operations |
| `ReviewRepositoryError` | unchanged |

Inside `fn(ctx)`:

| Operation | Status |
|---|---|
| `ctx.stageReviewItem(input)` | GM-23 |
| `ctx.listPendingReviewItems({limit?})` | GM-24 |
| `ctx.inspectReviewItem(queueId)` | GM-24 |
| `ctx.recordReviewDecision(input)` | GM-24 |
| `ctx.recordExecutionAuthorization(input)` | GM-25 |
| `ctx.listExecutionAuthorizations({limit?})` | GM-25 |
| `ctx.inspectExecutionAuthorization(authorizationId)` | GM-25 |
| `ctx.recordExecutionClaim(input)` | GM-26 |
| `ctx.listExecutionClaims({limit?})` | GM-26 |
| `ctx.inspectExecutionClaim(claimId)` | GM-26 |
| `ctx.recordExecutionAttempt(input)` | GM-27 |
| `ctx.listExecutionAttempts({limit?})` | GM-27 |
| `ctx.inspectExecutionAttempt(attemptId)` | GM-27 |
| `ctx.recordExecutionOutcome(input)` | GM-28 NEW |
| `ctx.listExecutionOutcomes({limit?})` | GM-28 NEW |
| `ctx.inspectExecutionOutcome(outcomeId)` | GM-28 NEW |

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 |
| `createExecutionAuthorizationActor` | GM-25 |
| `createExecutionClaimLedgerActor` | GM-26 |
| `createExecutionAttemptLedgerActor` | GM-27 |
| `createExecutionOutcomeLedgerActor` | GM-28 NEW |
| `OUTCOMES` enum | extended: 9-way (`outcome_recorded` added) |

## 6. Decision-verification chain (ten layers)

The execution-outcome ledger actor mirrors the GM-26 / GM-27
ledger actors' 10-layer chain:

1. `instanceof Decision`
2. `isValidDecision` (WeakSet)
3. `Object.isFrozen(decision)`
4. `decision.intentType === GOVERNANCE_EXECUTION_OUTCOME_RECORD`
5. Structural revalidation (REASONS, non-empty `policyRef`)
6. `decision.decision === ADMISSIBLE`
7. `params.userRole === 'admin'`
8. `params.authorizationScope ∈ AUTHORIZATION_SCOPES`
9. `params.executionSurface ∈ EXECUTION_SURFACES`
10. UUID validation on `pilotInstanceId` / `userId` / `executionAttemptId`

Plus a vocabulary precondition: `params.outcomeType ∈
VALID_EXECUTION_OUTCOME_TYPES`. The actor rejects any value
outside the locked 4-value set BEFORE opening a connection — so
`reported_succeeded`, `reported_failed`, `verified_completed`,
the uppercase variants, and any other smuggled vocabulary die
at the actor layer.

The **five DB-side data preconditions** (attempt exists; scope
equality; surface equality; recorder ≠ attempter; chain walks to
approved) are NOT duplicated at the actor — they live in the
BEFORE-INSERT trigger.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-28):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics. |
| FROM/JOIN allowlist += `governance_execution_outcomes` | Read access for `listExecutionOutcomes` / `inspectExecutionOutcome`. |
| INSERT INTO allowlist += `governance_execution_outcomes` | Write access for `recordExecutionOutcome`. |
| **File-scoped (NEW for GM-28):** GM-27's 8 outcome-implying words PLUS 10 NEW truth-claim words (`verified`, `confirmed`, `actual`, `actually`, `definitely`, `proven`, `certain`, `real`, `reality`, `truth`) forbidden in `src/actors/execution-outcome-ledger-actor.js` | Mechanical enforcement of OUTCOME ≠ TRUTH. STRICTEST scan in the substrate at 18 words. |

The file-scoped scan logic remains the shared
`runFileScopedForbiddenScan` helper (introduced in GM-27 per
OQ-27.17); GM-28 adds a third `FILE_SCOPED_SCANS` entry.

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording an outcome does the thing the outcome is "for" | No consumer exists; J22 static-scan canary asserts; doc forbids. |
| Recording an outcome mutates a prior row (queue / decision / authorization / claim / attempt) | All six tables are append-only; module writes only to the new table. |
| Recording against an attempt the same human initiated | BEFORE-INSERT trigger + actor early-failure check. |
| Recording twice against the same attempt | `UNIQUE(execution_attempt_id)` — replay forbidden in GM-28. |
| Cross-pilot outcome | Composite FK + RLS WITH CHECK. |
| Scope drift on the outcome row | BEFORE-INSERT trigger equality assertion. |
| Surface drift on the outcome row | BEFORE-INSERT trigger equality assertion. |
| Smuggling success / failure as a "reported_" value | `VALID_EXECUTION_OUTCOME_TYPES` Set + DB CHECK + J37 snapshot all reject `reported_succeeded` / `reported_failed`. |
| Smuggling verification vocabulary | DB CHECK rejects `verified_*`; J24 forbids the bare words in the actor file. |
| Non-admin recording an outcome | RLS WITH CHECK (admin role) + actor layer 7. |
| Recorder impersonation via input | Actor sources `recorded_by_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded outcome | Append-only trigger + no UPDATE/DELETE grants. |
| Operational OR truth-claim vocabulary creeping into the actor file | J24 + boundary guard file-scoped forbidden-vocabulary scan (18 words — strictest in the substrate). |
| The boundary doc loses its "What this is NOT" or "What remains unresolved" sections | J27 doc-presence canary asserts both sections remain present. |
| EVENT_TYPES widening | None. The outcomes table IS the artifact. J15 adversarial asserts the lock. |

## 9. Adversarial review additions (J-series)

`tests/governance/adversarial.test.js` extended:

| # | Probe | Defense |
|---|---|---|
| J1 | Plain-object Decision | Layer 1 |
| J2 | Prototype-tampered Decision | Layer 2 |
| J3 | Wrong intent type | Layer 4 |
| J5 | Non-admin role | Layer 7 |
| J14 | Sentinel content in unknown params field | Logger metadata-only |
| J15 | EVENT_TYPES snapshot | Unchanged at 2 values |
| **J22** | **Static scan: zero references outside writing path** | Canary against accidental consumer introduction |
| **J24** | **File-scoped forbidden-vocabulary scan on the ledger actor** | STRICTEST in the substrate — 18 words (GM-27's 8 + 10 truth-claim words) |
| **J27** | **Doc-presence canary** — both required sections present | Defends the future-verification GM against silent removal of the phantom-outcome warning |
| **J37** | **EXECUTION_OUTCOME_TYPES snapshot** — exactly 4 values, all `reported_*` prefixed | Constitutional canary: smuggled `reported_succeeded` / `verified_*` fails immediately |

Plus C-series snapshot updates:
- C2: REASONS grows from 15 to 16.
- C3: INTENT_TYPES grows from 12 to 13.
- C4: OUTCOMES grows from 8 to 9.

## 10. Logging hygiene

The execution-outcome ledger actor logs ONE event per recorded
outcome: `actor.execution_outcome.recorded` with typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `outcome_id` (UUID)
- `execution_attempt_id` (UUID)
- `authorization_scope` (locked GM-25 vocabulary)
- `execution_surface` (locked GM-26 vocabulary)
- `outcome_type` (locked GM-28 vocabulary — one of the 4 `reported_*` values)
- `recorded_by_user_id` (UUID)
- `recorded_by_role` (admin)

No free-text content; no payload; no recorder notes. No
operational success / failure markers — those words are
mechanically forbidden in this file. No truth-claim markers
(`verified`, `confirmed`, `actual`, etc.) — also mechanically
forbidden. J14 plants a sentinel in an unknown params field
(including `recorderNotes` and `payload`) and asserts it never
appears in any captured log line.

## What this is NOT

GM-28's outcome artifact records ONLY what a human reported
observing. It is NOT, and must never become:

- **truth**
- **verification**
- **a fact** (it is a report)
- **success** (`reported_succeeded` is forbidden)
- **failure** (`reported_failed` is forbidden)
- **delivery**, **dispatch**, **finalization**, **execution**
  (in the operational sense — the artifact's name
  notwithstanding)
- **a commit signal** (the database-level commit lives in the
  transaction layer, never in the actor file or this artifact's
  semantics)
- **a retry trigger** (no GM-28 consumer reads outcome rows to
  decide whether to retry)
- **an orchestration primitive** (this artifact records, it
  does not coordinate work)
- **a workflow state** (there are no state transitions; the row
  exists or it does not)
- **a default** (`reported_unknown` is an affirmative
  observation of epistemic uncertainty, NOT a placeholder)
- **a backfill source** (no GM may retroactively assign
  outcomes to pre-existing attempts based on inferred state)

Outcomes are also **OPTIONAL**. An attempt may exist forever
with no outcome row, and **the absence of an outcome row is
NOT itself an outcome** — it is silence. Any policy that treats
absence as a signal (e.g., "no outcome row after N minutes means
the attempt was abandoned") is OUTSIDE the GM-28 contract and
must be its own decision gate.

The `reported_*` prefix on every CHECK value is a structural
defense, not a naming convention. The prefix puts into the data
itself the fact that the row is an observation, not a verdict.
Removing the prefix — or admitting any value without it — is
the failure mode this design exists to prevent.

Any future code that consumes outcome rows for operational
purposes — i.e., to decide what to do next based on whether an
outcome row exists or what its `outcome_type` says — is OUTSIDE
the GM-28 contract and must be its own decision gate. J22
mechanically asserts zero such consumers exist.

The actor file is mechanically forbidden by J24 +
`check-review-boundary.js` from containing any of the 18 words:
`completed` / `succeeded` / `failed` / `delivered` /
`finalized` / `executed` / `dispatched` / `committed` /
`verified` / `confirmed` / `actual` / `actually` /
`definitely` / `proven` / `certain` / `real` / `reality` /
`truth` as bare identifiers.

## What remains unresolved

GM-28 deliberately refuses to answer the following questions.
The future-verification GM (whenever it is approved, with its
own OQ set) MUST address each of them explicitly. The J27
doc-presence canary asserts this section remains in the doc so
the warning is not silently removed.

1. **Verification ring.** Is there ever a downstream artifact
   that asserts whether the reported outcome corresponds to
   anything that actually happened? GM-28 ships no such ring.
   `reported_completed` ≠ `verified_completed`; the latter
   vocabulary does not exist anywhere in this substrate, and
   adding it requires its own decision gate.

2. **Missing-outcome semantics.** Is the absence of an outcome
   row itself an outcome? GM-28 says no — silence is silence —
   but the future-verification GM may need to take a position.
   Until then, no consumer may treat "no row" as a signal.

3. **Time windows.** Is there a deadline by which an outcome
   must be recorded? Does an attempt with no outcome after N
   minutes / hours / days flip to any state? GM-28 has no
   expiry, no timeouts, no scheduler. Any such window is a
   separate decision gate.

4. **Disagreeing observations.** GM-28 enforces
   `UNIQUE(execution_attempt_id)`, so two admins cannot record
   conflicting outcomes against the same attempt. What happens
   when two admins disagree about what they observed? The
   current substrate makes the second recorder lose
   structurally. Future GMs may need to introduce a contention
   primitive — that is a separate decision.

5. **Reconciliation with external state.** If a future
   execution-consumer surface emits side effects to external
   systems, how are outcome rows reconciled with external state?
   GM-28 has no external-side-effect capability and so cannot
   pre-define this. The `reported_*` vocabulary cannot be
   relied on as anything other than a human's report.

6. **Aggregate / analytic use.** May `outcome_type` ever be
   aggregated (counts, ratios, dashboards)? GM-28 takes no
   position; the substrate is admin-only and any analytic
   surface is a separate decision gate. An aggregation that
   treats `reported_completed` as a success rate would smuggle
   the truth claim the substrate refuses to make.

7. **Backfill of pre-GM-28 attempts.** If a future GM relaxes
   GM-28's recorder ≠ attempter rule, may pre-existing attempts
   be back-recorded by their attempter? GM-28 takes no
   position; the rule applies to all rows inserted under GM-28.

8. **Pre-verification-GM rows.** If a future GM introduces
   verification semantics, how are existing outcome rows
   (recorded before that GM landed) interpreted? Are they
   treated as unverified forever, or back-filled by some
   retroactive convention? GM-28 takes no position.

9. **Outcome revisions.** GM-28 forbids UPDATE/DELETE and
   forbids a second outcome row per attempt. If a future GM
   needs to correct a misrecorded outcome (e.g. the recorder
   mistyped), how? GM-28 provides no answer; correction is a
   separate decision gate that MUST address whether a
   correction is a new row, a revision row, or something else.

10. **Privacy boundary.** Outcomes are admin-only. If a future
    GM exposes outcome data to non-admin surfaces (family,
    caregiver, the subject themselves), the privacy model
    needs explicit re-derivation. GM-28 makes no such
    exposure.

The next governance decision gate that introduces verification
semantics, an aggregation surface, a correction primitive, OR
any consumer of outcome rows MUST start by enumerating which of
these ten questions it is answering and which it is deferring
further. A silent answer to any of them is the failure mode
this section exists to prevent.

## 11. Change control

Adding a new recorder role, an UPDATE / DELETE grant, an
outcome revocation column, a fifth `outcome_type` value,
verification semantics, aggregation surfaces, **any consumer of
`governance_execution_outcomes`**, OR any new vocabulary that
escapes the `reported_*` prefix is a boundary change. It
requires a reviewed change to:

- this document,
- `db/migrations/0NN_*.sql` (next number),
- `tests/rls-contract/synthetic-schema.sql`,
- `tests/rls-contract/policies.sql`,
- `tests/rls-contract/fixtures.sql`,
- `tests/rls-contract/run-contract.js`,
- `tests/rls-contract/run-real.test.js`,
- `tests/governance/adversarial.test.js` (snapshot + new probes; J37 in particular),
- `scripts/ci/check-review-boundary.js` if read/write allowlists
  or the file-scoped forbidden-vocabulary list shifts,
- `src/governance/intents.js` / `decisions.js` / `classifier.js`
  if new vocabulary lands,
- `src/review/repository.js` if `VALID_EXECUTION_OUTCOME_TYPES`
  shifts.

When the change introduces a consumer of recorded outcomes, the
same PR MUST explicitly answer every question enumerated in
"What remains unresolved" above. Silent answers fail process.

When the change introduces verification vocabulary, the same PR
MUST explicitly retire or refactor the `reported_*` prefix
discipline, justifying why putting the report-vs-verdict
distinction into the data itself is no longer required. The
prefix is the constitutional defense; removing it without
replacement is a process failure.

## Cross-references

- `review-queue-runtime-boundary.md` — GM-23 staging substrate.
- `review-decision-runtime-boundary.md` — GM-24 review-outcome
  substrate.
- `execution-authorization-runtime-boundary.md` — GM-25
  authorization substrate.
- `execution-claim-runtime-boundary.md` — GM-26 claim substrate.
- `execution-attempt-runtime-boundary.md` — GM-27 attempt
  substrate (this layer records observations against).
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-28 with the seventh Decision-gated actor, §4f).
- `governance-runtime-boundary.md` — classifier + Decision shape
  (extended in GM-28 with one intent type + one reason, §6g).
- `rls-privacy-contract.md` — engaged RLS policies.
- `baseline-ci.md` — CI guard set.
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/execution-outcome-ledger-actor.js` — the actor.
- `../../db/migrations/013_execution_outcomes.sql` — the migration.
- `../../tests/integration/execution-outcome.test.js` —
  integration proof.
- `../../tests/governance/adversarial.test.js` — J-series
  negative tests (J22 = consumer-leak canary; J24 = forbidden
  operational + truth-claim vocabulary; J27 = doc-presence
  canary; J37 = `EXECUTION_OUTCOME_TYPES` snapshot).
