# Execution-Attempt Runtime Boundary

**Applies to:** the execution-attempt substrate (`src/review/`
repository functions `recordExecutionAttempt`,
`listExecutionAttempts`, `inspectExecutionAttempt`; the new
`src/actors/execution-attempt-ledger-actor.js` actor; and the
`governance_execution_attempts` table created by
`db/migrations/012_execution_attempts.sql`). Introduced in GM-27
— the fifth persistence expansion since the process lock,
extending the GM-23/24/25/26 governance-staging chain with the
**first** artifact that names "execution" as something that
could happen.

**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, an UPDATE path, a new attempter
role, or relaxing any CHECK constraint requires paired updates
to this document, the migration chain, the rls-contract
synthetic suite, and the adversarial snapshot tests (C2/C3/C4)
plus the I-series in `tests/governance/adversarial.test.js`.
**Removing the "What this is NOT" or "What remains unresolved"
sections fails the I27 doc-presence canary.**

**Depends on:** all prior staging substrate docs
(`review-queue-runtime-boundary.md`,
`review-decision-runtime-boundary.md`,
`execution-authorization-runtime-boundary.md`,
`execution-claim-runtime-boundary.md`),
`governance-runtime-boundary.md` (classifier + Decision shape
the actor consumes), `actor-runtime-boundary.md` (actor
contract), `rls-privacy-contract.md` (engaged RLS policies).

## Purpose

GM-26 made replay structurally impossible: each authorization
can be claimed exactly once. But the chain still had no artifact
recording that an attempt was actually *initiated*. The moment a
future GM ships an execution consumer, it would have no place to
record "I tried" *separately from* "it worked," and the two
would inevitably collapse into "did it" — losing the audit-trail
distinction that lets governance reconstruct what actually
happened.

GM-27 adds the smallest possible **attempt** substrate:

- a different admin (not the claimant) can **explicitly begin**
  an execution attempt against a claim,
- the recorded attempt is **immutable** and **append-only**,
- each claim is attemptable **exactly once**
  (`UNIQUE(execution_claim_id)` — multi-attempt / retry
  semantics are forbidden in GM-27 per OQ-27.4),
- an attempter **cannot attempt against a claim they themselves
  recorded** (BEFORE-INSERT trigger),
- the attempt's `authorization_scope` and `execution_surface`
  must **equal** the claim's values (drift detection),
- the underlying review_decision must still be `'approved'`
  (defense-in-depth chain walk).

The substrate is **inert**. It records. Nothing in GM-27 reads
attempt rows operationally, executes anything, mutates memory,
schedules background work, or notifies external systems.

The constitutional rule (now applied at five levels):

> **Approval is not authorization.**
> **Authorization is not execution.**
> **An authorization row is not an execution signal.**
> **A claim row is not execution — it only records single-consumption.**
> **An attempt row is not an outcome — it only records the beginning of an attempt.**

GM-27 records attempts. It does NOT record outcomes.

## 1. Module placement

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes recordExecutionAttempt,
                       listExecutionAttempts, inspectExecutionAttempt
                       alongside the GM-23/24/25/26 ops.
  repository.js      — extended: 3 new functions.
  index.js           — public surface unchanged.

src/actors/
  outcomes.js        — + OUTCOMES.ATTEMPT_RECORDED = 'attempt_recorded'
  execution-attempt-ledger-actor.js   — NEW (per OQ-27.13; "ledger"
                       in the filename is MANDATORY and is the single
                       most important architectural defense at this
                       layer against operational drift).
  index.js           — + createExecutionAttemptLedgerActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_execution_attempts'
  - INSERT_ALLOWED_TABLES += 'governance_execution_attempts'
  - NEW: second file-scoped forbidden-vocabulary scan, refactored
    into the shared FILE_SCOPED_SCANS helper (per OQ-27.17). Bans
    `executed`/`completed`/`dispatched`/`delivered`/`finalized`/
    `succeeded`/`failed`/`committed` in
    `src/actors/execution-attempt-ledger-actor.js`. The list is
    STRICTER than the GM-26 claim-ledger scan by exactly one word:
    `committed` reads as outcome semantics most strongly at this
    layer (the database-level commit lives in the transaction
    layer, never in the actor file).

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — src/governance/ widens
  vocabulary by exactly one INTENT_TYPES + one REASONS + one
  POLICY_REFS + one classifier branch. Every other module
  UNCHANGED.

docs/governance/execution-attempt-runtime-boundary.md  — NEW (this doc).
db/migrations/012_execution_attempts.sql               — NEW.
```

## 2. Schema (`governance_execution_attempts`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `execution_claim_id` | UUID NOT NULL | composite FK + UNIQUE on its own |
| `authorization_scope` | TEXT NOT NULL | CHECK in GM-25's 4-value vocab; trigger asserts equality with the claim's scope |
| `execution_surface` | TEXT NOT NULL | CHECK in GM-26's 4-value vocab (all `future_*`); trigger asserts equality with the claim's surface |
| `attempted_by_user_id` | UUID NOT NULL | composite FK |
| `attempted_by_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (execution_claim_id)` — forbids retry / multi-attempt |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite-FK targets |
| — | — | composite FK `(pilot_instance_id, attempted_by_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, execution_claim_id)` → `governance_execution_claims` |

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No RLS policy could permit the operation even if a grant were added.

**Preconditions BEFORE-INSERT trigger** walks the 5-deep chain
attempt → claim → authorization → review_decision and enforces
five invariants:

| # | Check | Catches |
|---|---|---|
| (a) | claim exists in same pilot | nonexistent / cross-pilot reference |
| (b) | `attempt.authorization_scope = claim.authorization_scope` | scope drift |
| (c) | `attempt.execution_surface = claim.execution_surface` | surface drift |
| (d) | `claim.claimed_by_user_id ≠ attempt.attempted_by_user_id` | self-attempt |
| (e) | `review_decision.review_outcome = 'approved'` (full chain walk) | chain rot |

## 3. RLS policies

Two policies on `governance_execution_attempts`:

- **`attempt_insert_admin`** (INSERT WITH CHECK) — tenant match
  AND `attempted_by_user_id = current_setting('app.user_id')`
  AND `current_setting('app.user_role') = 'admin'`.
- **`attempt_admin_select`** (SELECT) — tenant match AND
  `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant /
attempter-as-non-admin / family / caregiver / runtime SELECT
policy.** Attempts are admin-only governance metadata.

**No UPDATE / DELETE policy.**

## 4. Locked vocabularies

GM-27 introduces **no new locked vocabulary**.

- `AUTHORIZATION_SCOPES` — inherited unchanged from GM-25 (4 values).
- `EXECUTION_SURFACES` — inherited unchanged from GM-26 (4 values, all `future_*` prefixed).
- `attempted_by_role` — CHECK-locked to `'admin'`.

The trigger asserts attempt-row scope/surface values equal the
claim's. Any drift is caught at INSERT time.

## 5. Public API surface (post-GM-27)

| Export | Status |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes thirteen operations |
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
| `ctx.recordExecutionAttempt(input)` | GM-27 NEW |
| `ctx.listExecutionAttempts({limit?})` | GM-27 NEW |
| `ctx.inspectExecutionAttempt(attemptId)` | GM-27 NEW |

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 |
| `createExecutionAuthorizationActor` | GM-25 |
| `createExecutionClaimLedgerActor` | GM-26 |
| `createExecutionAttemptLedgerActor` | GM-27 NEW |
| `OUTCOMES` enum | extended: 8-way (`attempt_recorded` added) |

## 6. Decision-verification chain (ten layers)

The execution-attempt ledger actor mirrors the GM-26 claim-ledger
actor's 10-layer chain:

1. `instanceof Decision`
2. `isValidDecision` (WeakSet)
3. `Object.isFrozen(decision)`
4. `decision.intentType === GOVERNANCE_EXECUTION_ATTEMPT`
5. Structural revalidation (REASONS, non-empty `policyRef`)
6. `decision.decision === ADMISSIBLE`
7. `params.userRole === 'admin'`
8. `params.authorizationScope ∈ AUTHORIZATION_SCOPES`
9. `params.executionSurface ∈ EXECUTION_SURFACES`
10. UUID validation on `pilotInstanceId` / `userId` / `executionClaimId`

The **five DB-side data preconditions** (claim exists; scope
equality; surface equality; attempter ≠ claimant; chain walks to
approved) are NOT duplicated at the actor — they live in the
BEFORE-INSERT trigger.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-27):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics. |
| FROM/JOIN allowlist += `governance_execution_attempts` | Read access for `listExecutionAttempts` / `inspectExecutionAttempt`. |
| INSERT INTO allowlist += `governance_execution_attempts` | Write access for `recordExecutionAttempt`. |
| **File-scoped (NEW for GM-27):** `executed`, `completed`, `dispatched`, `delivered`, `finalized`, `succeeded`, `failed`, **`committed`** forbidden in `src/actors/execution-attempt-ledger-actor.js` | Mechanical enforcement of ATTEMPT ≠ OUTCOME. Includes `committed` (one word stricter than GM-26's claim-ledger scan) because "committed" reads as outcome semantics most strongly at this layer. |

The file-scoped scan logic is refactored into a shared
`runFileScopedForbiddenScan` helper (per OQ-27.17) that the
GM-26 and GM-27 actor scans both use.

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording an attempt does the thing the attempt is "for" | No consumer exists; I23 static-scan canary asserts; doc forbids. |
| Recording an attempt mutates a prior row (queue / decision / authorization / claim) | All five tables are append-only; module writes only to the new table. |
| Attempting against a claim the same human recorded | BEFORE-INSERT trigger + actor early-failure check. |
| Attempting the same claim twice | `UNIQUE(execution_claim_id)` — multi-attempt / retry forbidden in GM-27. |
| Cross-pilot attempt | Composite FK + RLS WITH CHECK. |
| Scope drift on the attempt row | BEFORE-INSERT trigger equality assertion. |
| Surface drift on the attempt row | BEFORE-INSERT trigger equality assertion. |
| Non-admin recording an attempt | RLS WITH CHECK (admin role) + actor layer 7. |
| Attempter impersonation via input | Actor sources `attempted_by_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded attempt | Append-only trigger + no UPDATE/DELETE grants. |
| Operational vocabulary creeping into the actor file | I24 + boundary guard file-scoped forbidden-vocabulary scan (STRICTER than GM-26: adds `committed`). |
| The boundary doc loses its "What this is NOT" or "What remains unresolved" sections | I27 doc-presence canary asserts both sections remain present. |
| EVENT_TYPES widening | None. The attempts table IS the artifact. I15 adversarial asserts the lock. |

## 9. Adversarial review additions (I-series)

`tests/governance/adversarial.test.js` extended:

| # | Probe | Defense |
|---|---|---|
| I1 | Plain-object Decision | Layer 1 |
| I2 | Prototype-tampered Decision | Layer 2 |
| I3 | Wrong intent type | Layer 4 |
| I4 | Different governance.* intent | Layer 4 |
| I5 | Non-admin role | Layer 7 |
| I6 | Replay (UNIQUE) | DB UNIQUE constraint (integration) |
| I7 | Scope drift | DB trigger (integration) |
| I8 | Surface drift | DB trigger (integration) |
| I9 | Self-attempt | DB trigger (integration) |
| I14 | Sentinel content in unknown params field | Logger metadata-only |
| I15 | EVENT_TYPES snapshot | Unchanged at 2 values |
| I20 | AUTHORIZATION_SCOPES + EXECUTION_SURFACES snapshots unchanged | Snapshot |
| I21 | Attempter impersonation by input | Actor ignores input; RLS WITH CHECK |
| **I23** | **Static scan: zero references outside writing path** | The I-series canary against accidental consumer introduction |
| **I24** | **File-scoped forbidden-vocabulary scan on the ledger actor** | STRICTER than GM-26 H28 — adds `committed` |
| **I27** | **Doc-presence canary** — both required sections present | Defends the next-outcome GM against silent removal of the phantom-attempt warning |

Plus C-series snapshot updates:
- C2: REASONS grows from 14 to 15.
- C3: INTENT_TYPES grows from 11 to 12.
- C4: OUTCOMES grows from 7 to 8.

## 10. Logging hygiene

The execution-attempt ledger actor logs ONE event per recorded
attempt: `actor.execution_attempt.recorded` with typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `attempt_id` (UUID)
- `execution_claim_id` (UUID)
- `authorization_scope` (locked GM-25 vocabulary)
- `execution_surface` (locked GM-26 vocabulary)
- `attempted_by_user_id` (UUID)
- `attempted_by_role` (admin)

No free-text content; no payload. No outcome / success / failure
markers — those words are mechanically forbidden in this file.
I14 plants a sentinel in an unknown params field and asserts it
never appears in any captured log line.

## What this is NOT

GM-27's attempt artifact records ONLY that an attempt began. It
is NOT, and must never become:

- **success**
- **failure**
- **completion**
- **interruption**
- **delivery**
- **dispatch**
- **finalization**
- **execution** (in the operational sense — the artifact's name
  notwithstanding)
- **a commit signal** (the database-level commit lives in the
  transaction layer, never in the actor file or this artifact's
  semantics)
- **verification**
- **truth**
- **a retry primitive** (UNIQUE(execution_claim_id) forbids
  retries; future-retry semantics are a separate decision gate)
- **an orchestration primitive** (this artifact records, it does
  not coordinate work)
- **a workflow state** (there are no state transitions; the row
  exists or it does not)

Any future code that consumes attempt rows for operational
purposes — i.e., to decide what to do next based on whether an
attempt row exists — is OUTSIDE the GM-27 contract and must be
its own decision gate. I23 mechanically asserts zero such
consumers exist.

The actor file is mechanically forbidden by I24 +
`check-review-boundary.js` from containing any of `executed` /
`completed` / `dispatched` / `delivered` / `finalized` /
`succeeded` / `failed` / `committed` as bare identifiers.

## What remains unresolved

GM-27 deliberately refuses to answer the following questions.
The future-outcome GM (whenever it is approved, with its own OQ
set) MUST address each of them explicitly. The I27 doc-presence
canary asserts this section remains in the doc so the warning
is not silently removed.

1. **Phantom attempts.** An attempt row may exist forever
   without any corresponding outcome row, because GM-27 ships no
   outcome semantics. Is an attempt with no outcome treated as
   in-flight, abandoned, unknown, or successful-by-default? GM-27
   provides no answer; the future-outcome GM must decide.

2. **Time windows.** Is there a deadline by which an outcome
   must be recorded? Does an attempt expire if no outcome arrives
   within N minutes / hours / days? GM-27 has no expiry, no
   timeouts, no scheduler.

3. **Pre-outcome-GM rows.** If a future GM introduces outcome
   semantics, how are existing attempt rows (recorded before that
   GM landed) interpreted? Are they treated as outcome-unknown
   forever, or back-filled by some retroactive convention? GM-27
   takes no position.

4. **Missing-outcome semantics.** Is the absence of an outcome
   row itself an outcome? (e.g., "no record means failure")
   GM-27 takes no position; the future-outcome GM must decide
   whether to treat absence as a meaningful signal.

5. **Retry semantics.** GM-27's `UNIQUE(execution_claim_id)`
   forbids any second attempt against the same claim. If a future
   GM ships retry capability, it MUST decide: does retry create a
   second claim, a second attempt, both, neither, or something
   else? The schema does not pre-decide.

6. **Verification semantics.** Is an attempt "verified" if an
   outcome row exists? If a verification ring is added (as
   speculated in the GM-28 inspection), does it consume attempt
   rows, outcome rows, both, or neither? GM-27 takes no position.

7. **Truth claims.** None. GM-27 records ONLY what was reported
   to have begun; whether anything actually happened is outside
   the substrate.

8. **Reconciliation against external state.** If a future
   consumer surface emits side effects to external systems, how
   are attempt rows reconciled with external state? GM-27 has no
   external-side-effect capability and so cannot pre-define this.

The next governance decision gate that introduces outcome
semantics MUST start by enumerating which of these eight
questions it is answering and which it is deferring further. A
silent answer to any of them is the failure mode this section
exists to prevent.

## 11. Change control

Adding a new attempter role, an UPDATE / DELETE grant, an
attempt revocation column, retry / multi-attempt semantics,
outcome / success / failure semantics, OR **any consumer of
`governance_execution_attempts`** is a boundary change. It
requires a reviewed change to:

- this document,
- `db/migrations/0NN_*.sql` (next number),
- `tests/rls-contract/synthetic-schema.sql`,
- `tests/rls-contract/policies.sql`,
- `tests/rls-contract/fixtures.sql`,
- `tests/rls-contract/run-contract.js`,
- `tests/rls-contract/run-real.test.js`,
- `tests/governance/adversarial.test.js` (snapshot + new probes),
- `scripts/ci/check-review-boundary.js` if read/write allowlists
  or the file-scoped forbidden-vocabulary list shifts,
- `src/governance/intents.js` / `decisions.js` / `classifier.js`
  if new vocabulary lands.

When the change introduces a consumer of recorded attempts, the
same PR MUST explicitly answer every question enumerated in
"What remains unresolved" above. Silent answers fail process.

## Cross-references

- `review-queue-runtime-boundary.md` — GM-23 staging substrate.
- `review-decision-runtime-boundary.md` — GM-24 review-outcome
  substrate.
- `execution-authorization-runtime-boundary.md` — GM-25
  authorization substrate.
- `execution-claim-runtime-boundary.md` — GM-26 claim substrate
  (this layer attempts against).
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-27 with the sixth Decision-gated actor, §4e).
- `governance-runtime-boundary.md` — classifier + Decision shape
  (extended in GM-27 with one intent type + one reason, §6f).
- `rls-privacy-contract.md` — engaged RLS policies.
- `baseline-ci.md` — CI guard set.
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/execution-attempt-ledger-actor.js` — the actor.
- `../../db/migrations/012_execution_attempts.sql` — the migration.
- `../../tests/integration/execution-attempt.test.js` —
  integration proof.
- `../../tests/governance/adversarial.test.js` — I-series
  negative tests (I23 = consumer-leak canary; I24 = forbidden
  operational vocabulary; I27 = doc-presence canary).
