# Execution-Claim Runtime Boundary

**Applies to:** the execution-claim substrate (`src/review/`
repository functions `recordExecutionClaim`,
`listExecutionClaims`, `inspectExecutionClaim`; the new
`src/actors/execution-claim-ledger-actor.js` actor; and the
`governance_execution_claims` table created by
`db/migrations/011_execution_claims.sql`). Introduced in GM-26 —
the fourth persistence expansion since the process lock,
extending the GM-23/24/25 review/authorization substrates with a
parallel append-only artifact for an admin's explicit
single-consumption claim of an authorization.

**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, an UPDATE path, a new claimant role,
a new execution surface, or relaxing any CHECK constraint
requires paired updates to this document, the migration chain,
the rls-contract synthetic suite, the adversarial snapshot tests
(C2/C3/C4 + H19/H20), and the H-series in
`tests/governance/adversarial.test.js`.

**Depends on:** `review-queue-runtime-boundary.md` (GM-23 staging
substrate at the root of the chain),
`review-decision-runtime-boundary.md` (GM-24 review-outcome
substrate, the chain walk terminates here),
`execution-authorization-runtime-boundary.md` (GM-25
authorization substrate this layer claims from),
`governance-runtime-boundary.md` (classifier + Decision shape the
actor consumes), `actor-runtime-boundary.md` (actor contract),
`rls-privacy-contract.md` (engaged RLS policies).

## Purpose

GM-25 made an admin's explicit authorization durably recordable.
But an authorization row, by itself, can be referenced by any
future code as many times as it wants — there is no structural
single-use semantics. The moment any future GM ships a consumer
(e.g., "execute on authorized items"), nothing in the substrate
prevents the consumer from acting on the same authorization N
times. That is **replayable authority**.

GM-26 adds the smallest possible **claim** substrate that
mechanically introduces single-consumption semantics:

- a different admin (not the authorizer) can **explicitly claim**
  an authorization for one specific future execution surface,
- the recorded claim is **immutable** and **append-only**,
- each authorization is claimable **exactly once**
  (`UNIQUE(execution_authorization_id)` — the replay-prevention
  wall),
- a claimant **cannot claim an authorization they themselves
  recorded** (BEFORE-INSERT trigger),
- the claim's `authorization_scope` must **equal** the
  authorization's scope (drift detection),
- the claim's `execution_surface` must **fit** the
  `authorization_scope` per a 1:1 mapping (BEFORE-INSERT trigger),
- the underlying review_decision must still be `'approved'`
  (defense-in-depth chain walk — impossible-by-design today, but
  the cheap walk catches any future drift in the review-decision
  layer).

The substrate is **inert**. It records. Nothing in GM-26 reads
claim rows operationally, executes anything, mutates memory,
schedules background work, or notifies external systems. A
future execution surface would be required to consume
`governance_execution_claims` rows.

The constitutional rule (now applied at four levels):

> **Claim is NOT execution.**
> **Claim is NOT dispatch.**
> **Claim is NOT completion.**
> **Claim is NOT success.**
> **Claim ONLY means: "this authorization has now been consumed exactly once."**

GM-26 records claims. It does not execute. The actor filename
includes "ledger" to make the read-only / record-only nature
visible at the file level. The boundary guard mechanically
forbids operational vocabulary (`executed`, `completed`,
`dispatched`, etc.) inside that one file.

## 1. Module placement (extending the GM-23/24/25 surface)

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes recordExecutionClaim,
                       listExecutionClaims,
                       inspectExecutionClaim alongside the
                       GM-23/24/25 ops.
  repository.js      — extended: 3 new functions + the GM-26 locked
                       vocabularies (VALID_EXECUTION_SURFACES,
                       VALID_CLAIM_ROLES, EXECUTION_SURFACE_FOR_SCOPE).
  index.js           — public surface unchanged.

src/actors/
  outcomes.js        — + OUTCOMES.CLAIM_RECORDED = 'claim_recorded'
  execution-claim-ledger-actor.js   — NEW (per OQ-26.13).
  index.js           — + createExecutionClaimLedgerActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_execution_claims'
  - INSERT_ALLOWED_TABLES += 'governance_execution_claims'
  - NEW: file-scoped forbidden-vocabulary scan on
    src/actors/execution-claim-ledger-actor.js — bans
    `executed`/`completed`/`dispatched`/`delivered`/`finalized`/
    `succeeded`/`failed` as bare identifiers in that one file
    (per OQ-26.14). The scan does NOT apply module-wide because
    these words legitimately appear elsewhere (e.g.
    OUTCOMES.EXECUTED, response-delivery actor docs).

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — src/governance/ widens
  vocabulary by exactly one INTENT_TYPES + one REASONS + one
  POLICY_REFS + one classifier branch. Every other module
  UNCHANGED.

docs/governance/execution-claim-runtime-boundary.md  — NEW (this doc).
db/migrations/011_execution_claims.sql               — NEW.
```

## 2. Schema (`governance_execution_claims`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `execution_authorization_id` | UUID NOT NULL | composite FK + UNIQUE on its own (the replay-prevention wall) |
| `authorization_scope` | TEXT NOT NULL | CHECK in 4-value GM-25 vocabulary |
| `execution_surface` | TEXT NOT NULL | CHECK in 4-value GM-26 vocabulary (§4); mandatory `future_*` prefix |
| `claimed_by_user_id` | UUID NOT NULL | composite FK |
| `claimed_by_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (execution_authorization_id)` |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite-FK targets |
| — | — | composite FK `(pilot_instance_id, claimed_by_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, execution_authorization_id)` → `governance_execution_authorizations` |

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No RLS policy could permit the operation even if a grant were added.

**Preconditions BEFORE-INSERT trigger** walks the chain
claim → authorization → review_decision and enforces five
invariants:

| # | Check | Catches |
|---|---|---|
| (a) | authorization exists in same pilot | nonexistent / cross-pilot reference |
| (b) | `claim.authorization_scope = authorization.authorization_scope` | scope drift |
| (c) | `auth.authorized_by_user_id ≠ claim.claimed_by_user_id` | self-claim |
| (d) | `execution_surface` fits `authorization_scope` per the 1:1 mapping | surface confusion |
| (e) | `review_decision.review_outcome = 'approved'` | chain rot (impossible-by-design today, but cheap to assert) |

The scope ↔ surface mapping (locked in the trigger):

| authorization_scope | execution_surface |
|---|---|
| `memory_candidate_admission` | `future_memory_admission_consumer` |
| `future_external_action` | `future_external_action_consumer` |
| `future_visibility_change` | `future_visibility_change_consumer` |
| `future_vault_action` | `future_vault_action_consumer` |

## 3. RLS policies

Two policies on `governance_execution_claims`:

- **`claim_insert_admin`** (INSERT WITH CHECK) — tenant match AND
  `claimed_by_user_id = current_setting('app.user_id')` AND
  `current_setting('app.user_role') = 'admin'`.
- **`claim_admin_select`** (SELECT) — tenant match AND
  `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant-as-non-admin /
family / caregiver / runtime SELECT policy.** Claims are
admin-only governance metadata.

**No UPDATE / DELETE policy.** Append-only at every layer.

## 4. Locked vocabularies

`EXECUTION_SURFACES` — 4 values (NEW in GM-26), all mandatorily
`future_*` prefixed:

| Value | When used (today) |
|---|---|
| `future_memory_admission_consumer` | fits `memory_candidate_admission` scope |
| `future_external_action_consumer` | fits `future_external_action` scope |
| `future_visibility_change_consumer` | fits `future_visibility_change` scope |
| `future_vault_action_consumer` | fits `future_vault_action` scope |

The `future_*` prefix is **constitutional discipline**: GM-26
ships **zero consumers**. The prefix puts that fact into the
data itself. H27 is a snapshot test that asserts every
EXECUTION_SURFACES value matches `/^future_/`; H19 asserts the
exact 4-value set. Any non-prefixed addition fails both tests
immediately.

`claimed_by_role` — 1 value:

| Value | When used |
|---|---|
| `admin` | only role permitted in GM-26 |

`AUTHORIZATION_SCOPES` (from GM-25) — unchanged. H20 asserts.

## 5. Public API surface (post-GM-26)

| Export | Status |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes ten operations |
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
| `ctx.recordExecutionClaim(input)` | GM-26 NEW |
| `ctx.listExecutionClaims({limit?})` | GM-26 NEW |
| `ctx.inspectExecutionClaim(claimId)` | GM-26 NEW |

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 |
| `createExecutionAuthorizationActor` | GM-25 |
| `createExecutionClaimLedgerActor` | GM-26 NEW |
| `OUTCOMES` enum | extended: 7-way (`claim_recorded` added) |

## 6. Decision-verification chain (ten layers including admin-only + dual vocabulary locks)

The execution-claim ledger actor inherits the GM-22/23/24/25
chain and adds actor-specific layers:

| # | Check | Catches |
|---|---|---|
| 1 | `instanceof Decision` | Plain-object duck-types |
| 2 | `isValidDecision` (WeakSet) | Prototype-tampering forgeries |
| 3 | `Object.isFrozen(decision)` | Mutation post-classification |
| 4 | `decision.intentType === GOVERNANCE_EXECUTION_CLAIM` | Wrong intent type |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` non-empty | Vocabulary drift |
| 6 | `decision.decision === ADMISSIBLE` | Outcome confusion |
| 7 | `params.userRole === 'admin'` | Non-admin (rejected BEFORE any DB call) |
| 8 | `authorizationScope ∈ AUTHORIZATION_SCOPES` | GM-25 vocab |
| 9 | `executionSurface ∈ EXECUTION_SURFACES` | GM-26 vocab |
| 10 | UUID validation on `pilotInstanceId` / `userId` / `executionAuthorizationId` | Structural |

The **five DB-side data preconditions** (authorization exists in
same pilot; scope equality; claimant ≠ authorizer; surface fits
scope; underlying review still approved) are NOT duplicated at
the actor — they live in the BEFORE-INSERT trigger.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-26):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics on all four tables. |
| FROM/JOIN allowlist = `governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations`, **`governance_execution_claims`**, `users`, `pilot_instances` | The module reads only these tables. |
| INSERT INTO allowlist = `governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations`, **`governance_execution_claims`** | The module writes only these tables. |
| `pg` import scoped to `src/review/client.js` only | One pg-aware file. |
| Every model SDK forbidden | The substrate calls no model. |
| HTTP/server framework forbidden | No HTTP. |
| `child_process`/`worker_threads`/`cluster` forbidden | No subprocess, no worker. |
| `setInterval`/`setImmediate`/`cron`/`schedule` forbidden | No scheduling. |
| `fs.write*`/`appendFile*`/`createWriteStream`/`mkdir*`/`rm*`/`unlink*` forbidden | No filesystem writes. |
| `insertPrivateMemory` identifier forbidden | Defense in depth — no memory writes. |
| Streaming + tool-calling identifiers forbidden | Defense in depth. |
| **File-scoped (NEW for GM-26):** operational vocabulary forbidden in `src/actors/execution-claim-ledger-actor.js` — `executed`, `completed`, `dispatched`, `delivered`, `finalized`, `succeeded`, `failed` (after comment-stripping) | Per OQ-26.14: makes "claim is not execution" mechanically enforceable. |

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording a claim executes the action | No consumer exists; no actor reads `governance_execution_claims` operationally; doc forbids; **H22 static-scan canary** mechanically asserts. |
| Recording a claim mutates a prior row (queue / review_decision / authorization) | All four tables are append-only; module writes only to the new table. |
| Claiming an authorization the same human recorded | BEFORE-INSERT trigger + actor early-failure check. |
| Claiming the same authorization twice | `UNIQUE(execution_authorization_id)` — the replay-prevention wall. |
| Cross-pilot claim | Composite FK `(pilot_instance_id, execution_authorization_id) → governance_execution_authorizations` + RLS WITH CHECK. |
| Scope drift on the claim row | BEFORE-INSERT trigger equality assertion (§2 (b)). |
| Execution surface that doesn't fit the scope | BEFORE-INSERT trigger 1:1 mapping (§2 (d)). |
| Non-admin recording a claim | RLS WITH CHECK (admin role) + actor layer 7. |
| Claimant impersonation via input | Actor sources `claimed_by_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded claim | Append-only trigger + no UPDATE/DELETE grants. |
| Operational vocabulary creeping into the actor file | **H28 + boundary guard file-scoped forbidden-vocabulary scan** mechanically enforces. |
| Adding a non-`future_*` EXECUTION_SURFACES value | **H19 + H27 snapshot tests** assert exactly 4 values, all matching `/^future_/`. |
| EVENT_TYPES widening | None. The claims table IS the artifact. H15 adversarial asserts the lock. |

## 9. Adversarial review additions (H-series)

`tests/governance/adversarial.test.js` extended:

| # | Probe | Defense |
|---|---|---|
| H1 | Plain-object Decision | Layer 1 |
| H2 | Prototype-tampered Decision | Layer 2 |
| H3 | Wrong intent type | Layer 4 |
| H4 | Different governance.* intent | Layer 4 |
| H5 | Non-admin role | Layer 7 |
| H6 | Replay (UNIQUE) | DB UNIQUE constraint (integration) |
| H7 | Scope drift | DB trigger (integration) |
| H8 | Non-UUID ids | Layer 10 |
| H9 | Self-claim | DB trigger + actor (integration) |
| H14 | Sentinel content in unknown params field | Logger metadata-only |
| H15 | EVENT_TYPES snapshot | Unchanged at 2 values |
| H19 | EXECUTION_SURFACES vocabulary lock + prefix discipline | Snapshot |
| H20 | AUTHORIZATION_SCOPES snapshot unchanged | Snapshot |
| H21 | Claimant impersonation by input | Actor ignores input; RLS WITH CHECK |
| H22 | **Static scan: zero references outside writing path** | The H-series canary |
| H27 | EXECUTION_SURFACES prefix discipline standalone | Snapshot enforcement |
| H28 | **File-scoped forbidden-vocabulary scan on the ledger actor** | Mirrors the boundary-guard mechanical defense |

Plus C-series snapshot updates:
- C2: REASONS grows from 13 to 14.
- C3: INTENT_TYPES grows from 10 to 11.
- C4: OUTCOMES grows from 6 to 7.

Integration suite (`tests/integration/execution-claim.test.js`)
covers DB-side counterparts: self-claim trigger, replay UNIQUE,
scope-drift trigger, surface-mismatch trigger, cross-pilot
composite-FK rejection, non-admin RLS WITH CHECK, append-only
trigger, lylo_runtime GRANT denied.

## 10. Logging hygiene

The execution-claim ledger actor logs ONE event per recorded
claim: `actor.execution_claim.recorded` with typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `claim_id` (UUID)
- `execution_authorization_id` (UUID)
- `authorization_scope` (locked GM-25 vocabulary)
- `execution_surface` (locked GM-26 vocabulary)
- `claimed_by_user_id` (UUID)
- `claimed_by_role` (admin)

No free-text content; no payload; no evidence. H14 plants a
sentinel in an unknown params field and asserts it never appears
in any captured log line.

## 11. Change control

Adding a new EXECUTION_SURFACES value (and the corresponding
1:1-paired AUTHORIZATION_SCOPES value if it doesn't already
exist), a new claimant role, an UPDATE / DELETE grant, a claim
revocation / expiry column, or **any consumer of
`governance_execution_claims`** is a boundary change. It
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
  shift,
- `src/governance/intents.js` / `decisions.js` / `classifier.js`
  if new vocabulary lands.

When the change introduces a consumer of recorded claims, the
same PR MUST explicitly establish:
- whether the consumer is mounted,
- what its boundary guard is,
- what its adversarial review covers,
- what its OQ set looked like,
- how revocation, expiry, partial-consumption, and rollback are
  handled (none of those exist in GM-26).

A silent consumer is the failure mode this substrate is designed
to prevent. H22 is the canary; H28 mechanically forbids the
operational vocabulary that would suggest a consumer is being
implemented inline.

## Cross-references

- `review-queue-runtime-boundary.md` — the GM-23 staging substrate.
- `review-decision-runtime-boundary.md` — the GM-24 review-outcome
  substrate (chain walk terminates here).
- `execution-authorization-runtime-boundary.md` — the GM-25
  authorization substrate this layer claims from.
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-26 with the fifth Decision-gated actor, §4d).
- `governance-runtime-boundary.md` — classifier + Decision shape
  (extended in GM-26 with one intent type + one reason, §6e).
- `rls-privacy-contract.md` — engaged RLS policies (extended in
  GM-26 with the new table policies).
- `baseline-ci.md` — CI guard set (review boundary guard
  extended).
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/execution-claim-ledger-actor.js` — the actor.
- `../../db/migrations/011_execution_claims.sql` — the migration.
- `../../tests/integration/execution-claim.test.js` — integration
  proof.
- `../../tests/governance/adversarial.test.js` — H-series
  negative tests (H22 = consumer-leak canary; H27 = prefix
  discipline; H28 = forbidden-vocabulary file scan).
