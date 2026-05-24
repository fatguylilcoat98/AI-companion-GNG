# Execution-Authorization Runtime Boundary

**Applies to:** the execution-authorization substrate (`src/review/`
repository functions `recordExecutionAuthorization`,
`listExecutionAuthorizations`, `inspectExecutionAuthorization`;
the new `src/actors/execution-authorization-actor.js` actor; and
the `governance_execution_authorizations` table created by
`db/migrations/010_execution_authorizations.sql`). Introduced in
GM-25 — the third persistence expansion since the process lock,
extending the GM-23/24 review-queue and review-decision substrates
with a parallel append-only artifact for an admin's explicit
execution authorization.

**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-review-boundary.js` in the same PR.
Adding a status transition, an UPDATE path, a new authorizer role,
a new authorization scope, a new authorization reason, or
relaxing any CHECK constraint requires paired updates to this
document, the migration chain, the rls-contract synthetic suite,
and the adversarial snapshot tests (C2/C3/C4) plus the G-series
in `tests/governance/adversarial.test.js`.

**Depends on:** `review-queue-runtime-boundary.md` (GM-23
substrate this layer references through review_decisions),
`review-decision-runtime-boundary.md` (GM-24 substrate this layer
authorizes from), `governance-runtime-boundary.md` (classifier +
Decision shape the actor consumes),
`actor-runtime-boundary.md` (actor contract), `rls-privacy-contract.md`
(engaged RLS policies).

## Purpose

GM-24 made human review outcomes durably recordable. But a
recorded "approved" review is **not** authorization to act — it
is a governance artifact that a human admin examined and
approved. Without a separate, explicit authorization step, any
future execution surface would face the conceptual collapse
"approved = ready to execute" and the four-stage governance
chain (propose → review → authorize → execute) would degrade to
two stages.

GM-25 adds the smallest possible **authorization** substrate
that mechanically preserves the separation:

- a different admin (not the reviewer) can **explicitly authorize**
  an approved review_decision for eventual execution,
- the recorded authorization is **immutable** and **append-only**,
- each review_decision is authorizable **exactly once**
  (`UNIQUE(review_decision_id)`),
- an authorizer **cannot authorize a review they themselves
  recorded** (BEFORE-INSERT trigger),
- a rejected review **cannot be authorized** (BEFORE-INSERT
  trigger),
- the authorization **scope must match** the underlying queue
  item's intent type (BEFORE-INSERT trigger),
- the underlying review_decision row is **never mutated** — the
  GM-24 immutability invariant holds.

The substrate is **inert**. It records. Nothing in GM-25 reads
authorization rows operationally, executes anything, mutates
memory, schedules background work, or notifies external systems.
A future execution surface (a separate decision gate) would be
required to consume `governance_execution_authorizations` rows.

The constitutional rule (now applied at three levels):

> **Approval is not authorization. Authorization is not execution.**
> **An authorization row is NOT an execution signal.**

GM-25 records authorizations. It does not execute.

## 1. Module placement (extending the GM-23/24 surface)

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes recordExecutionAuthorization,
                       listExecutionAuthorizations,
                       inspectExecutionAuthorization alongside the
                       GM-23/24 ops.
  repository.js      — extended: 3 new functions + the GM-25 locked
                       vocabularies (VALID_AUTHORIZATION_SCOPES,
                       VALID_AUTHORIZATION_REASONS,
                       VALID_AUTHORIZATION_ROLES).
  index.js           — public surface unchanged.

src/actors/
  outcomes.js        — + OUTCOMES.AUTHORIZED_RECORDED = 'authorized_recorded'
  execution-authorization-actor.js   — NEW.
  index.js           — + createExecutionAuthorizationActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_execution_authorizations'
  - INSERT_ALLOWED_TABLES += 'governance_execution_authorizations'
  every other ban unchanged.

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — src/governance/ widens
  vocabulary by exactly one INTENT_TYPES + one REASONS + one
  POLICY_REFS + one classifier branch. Every other module
  UNCHANGED.

docs/governance/execution-authorization-runtime-boundary.md  — NEW (this doc).
db/migrations/010_execution_authorizations.sql               — NEW.
```

## 2. Schema (`governance_execution_authorizations`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `review_decision_id` | UUID NOT NULL | composite FK + UNIQUE on its own |
| `authorized_by_user_id` | UUID NOT NULL | composite FK |
| `authorized_by_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `authorization_scope` | TEXT NOT NULL | CHECK in 4-value vocabulary (§4) |
| `authorization_reason` | TEXT NOT NULL | CHECK in 1-value vocabulary (§4) |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (review_decision_id)` |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite-FK targets |
| — | — | composite FK `(pilot_instance_id, authorized_by_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, review_decision_id)` → `governance_review_decisions` |

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No RLS policy could permit the operation even if a grant were added.

**Preconditions BEFORE-INSERT trigger** walks the chain
authorization → review_decision → review_queue and enforces four
invariants:

| # | Check | Catches |
|---|---|---|
| (a) | review_decision exists in same pilot | nonexistent / cross-pilot reference |
| (b) | review_decision.review_outcome = 'approved' | authorizing a rejected review |
| (c) | reviewer_user_id ≠ authorized_by_user_id | self-authorization |
| (d) | authorization_scope matches the queue's decision_intent_type via a hardcoded mapping | scope confusion |

The scope ↔ intent mapping (locked in the trigger):

| Intent type | Required scope |
|---|---|
| `memory.candidate.create` | `memory_candidate_admission` |
| `memory.visibility.promote` | `future_visibility_change` |
| `vault.session.open` / `vault.session.revoke` | `future_vault_action` |
| `external.side_effect` | `future_external_action` |
| anything else | — (rejected) |

`response.deliver` and `governance.review.decide` are admissible
intents — they never produce a `requires_review` and never get
staged into the queue, so they cannot have a review_decision, so
they cannot reach this table. The trigger doesn't need to handle
them; the `ELSE FALSE` arm refuses.

## 3. RLS policies

Two policies on `governance_execution_authorizations`:

- **`auth_insert_admin`** (INSERT WITH CHECK) — tenant match AND
  `authorized_by_user_id = current_setting('app.user_id')` AND
  `current_setting('app.user_role') = 'admin'`. Non-admin INSERT
  is rejected even with an otherwise-valid payload.
- **`auth_admin_select`** (SELECT) — tenant match AND
  `app.user_role = 'admin'`. Admins see all authorizations in
  their pilot.

**No proposer / reviewer / authorizer-as-non-admin / family /
caregiver / runtime SELECT policy.** Authorizations are
admin-to-admin governance metadata.

**No UPDATE / DELETE policy.** Append-only at every layer.

## 4. Locked vocabularies

`AUTHORIZATION_SCOPES` — 4 values (CHECK constraint mirrors JS):

| Value | When used |
|---|---|
| `memory_candidate_admission` | underlying intent is `memory.candidate.create` |
| `future_external_action` | placeholder — `external.side_effect` is currently `inadmissible`, so unreachable today |
| `future_visibility_change` | placeholder — `memory.visibility.promote` is currently `inadmissible` |
| `future_vault_action` | placeholder — vault session intents are currently `inadmissible` |

The `future_*` prefix is intentional: GM-25 ships these scopes
ahead of the intent types they correspond to becoming reachable.
The trigger's scope ↔ intent mapping covers all four for forward
safety; only `memory_candidate_admission` has a live path today.

`AUTHORIZATION_REASONS` — 1 value:

| Value | When used |
|---|---|
| `admin_explicit_authorization` | the generic case (only case in GM-25) |

`authorized_by_role` — 1 value:

| Value | When used |
|---|---|
| `admin` | only role permitted in GM-25 |

Widening any of these requires paired updates to the migration,
the repository, the actor, this doc, and the C-series adversarial
snapshot tests.

## 5. Public API surface (post-GM-25)

| Export | Status |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes seven operations |
| `ReviewRepositoryError` | unchanged |

Inside `fn(ctx)`:

| Operation | Status |
|---|---|
| `ctx.stageReviewItem(input)` | GM-23 |
| `ctx.listPendingReviewItems({limit?})` | GM-24 |
| `ctx.inspectReviewItem(queueId)` | GM-24 |
| `ctx.recordReviewDecision(input)` | GM-24 |
| `ctx.recordExecutionAuthorization(input)` | GM-25 NEW |
| `ctx.listExecutionAuthorizations({limit?})` | GM-25 NEW |
| `ctx.inspectExecutionAuthorization(authorizationId)` | GM-25 NEW |

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 |
| `createExecutionAuthorizationActor` | GM-25 NEW |
| `OUTCOMES` enum | extended: 6-way (`authorized_recorded` added) |

Operations explicitly NOT in this surface:

- Any UPDATE / DELETE op on any review/authorization table.
- Any "authorize and execute" path (no consumer exists in GM-25).
- Any revocation, expiry, or status transition for authorizations.
- Any notification / scheduler / poller.

## 6. Decision-verification chain (the eighth layer is admin-only + vocabulary lock)

The execution-authorization actor inherits the GM-22/23/24 chain
and adds actor-specific layers:

| # | Check | Catches |
|---|---|---|
| 1 | `instanceof Decision` | Plain-object duck-types |
| 2 | `isValidDecision` (WeakSet) | Prototype-tampering forgeries |
| 3 | `Object.isFrozen(decision)` | Mutation post-classification |
| 4 | `decision.intentType === GOVERNANCE_EXECUTION_AUTHORIZE` | Wrong intent type |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` non-empty | Vocabulary drift |
| 6 | `decision.decision === ADMISSIBLE` | Outcome confusion |
| 7 | `params.userRole === 'admin'` | Non-admin (rejected BEFORE any DB call) |
| 8 | `authorizationScope ∈ AUTHORIZATION_SCOPES`, `authorizationReason ∈ AUTHORIZATION_REASONS`, UUID validation | Vocabulary + structural |

The **four DB-side data preconditions** (review exists,
approved, authorizer ≠ reviewer, scope ↔ intent) are NOT
duplicated at the actor; they live in the BEFORE-INSERT trigger.
Same posture as GM-24's self-review trigger — the actor catches
early-failure cases (typos, missing fields); the trigger is the
unforgeable wall against forged inserts.

Any actor verification failure throws. The pool is not consulted
on any failure path.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-25):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics on all three tables. |
| FROM/JOIN allowlist = `governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations`, `users`, `pilot_instances` | The module reads only these tables. |
| INSERT INTO allowlist = `governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations` | The module writes only these tables. |
| `pg` import scoped to `src/review/client.js` only | One pg-aware file. |
| Every model SDK forbidden | The substrate calls no model. |
| HTTP/server framework forbidden | No HTTP. |
| `child_process`/`worker_threads`/`cluster` forbidden | No subprocess, no worker. |
| `setInterval`/`setImmediate`/`cron`/`schedule` forbidden | No scheduling. |
| `fs.write*`/`appendFile*`/`createWriteStream`/`mkdir*`/`rm*`/`unlink*` forbidden | No filesystem writes. |
| `insertPrivateMemory` identifier forbidden | Defense in depth — no memory writes. |
| Streaming + tool-calling identifiers forbidden | Defense in depth. |

`scripts/ci/check-actors-boundary.js` is **unchanged**. The
existing `../review` public-entry allowance from GM-23/24 covers
the new actor.

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording an authorization executes the action | No consumer exists; no actor reads `governance_execution_authorizations` operationally; doc forbids; **G13 static-scan canary** mechanically asserts. |
| Recording an authorization mutates a prior row (queue or review_decision) | All three tables are append-only; module writes only to the new table. |
| Authorizing a review the same human recorded | BEFORE-INSERT trigger + actor early-failure check. |
| Authorizing a rejected review | BEFORE-INSERT trigger walks to `review_outcome` and refuses non-approved. |
| Authorizing twice for the same review_decision | `UNIQUE(review_decision_id)` + actor layer rejects vocabulary first when applicable. |
| Cross-pilot authorization | Composite FK `(pilot_instance_id, review_decision_id) → governance_review_decisions` + RLS WITH CHECK. |
| Scope-↔-intent mismatch | BEFORE-INSERT trigger with hardcoded mapping (§2 (d)). |
| Non-admin recording an authorization | RLS WITH CHECK (admin role) + actor layer 7. |
| Authorizer impersonation via input | Actor sources `authorized_by_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded authorization | Append-only trigger + no UPDATE/DELETE grants. |
| Adding a new authorization_scope / authorization_reason without paired update | CHECK constraint + adversarial snapshot tests. |
| EVENT_TYPES widening | None. The authorizations table IS the artifact. G11 adversarial asserts the lock. |

## 9. Adversarial review additions (G-series)

`tests/governance/adversarial.test.js` extended:

| # | Probe | Defense |
|---|---|---|
| G1 | Plain-object Decision | Layer 1 |
| G2 | Prototype-tampered Decision | Layer 2 |
| G3 | Wrong intent type | Layer 4 |
| G4 | Response-deliver intent (different intent class) | Layer 4 |
| G5 | Non-admin role | Layer 7 |
| G6 | authorizationScope outside vocab | Layer 8 + DB CHECK |
| G7 | authorizationReason outside vocab | Layer 8 + DB CHECK |
| G8 | Non-UUID ids | Layer 8 |
| G9 | Authorizer impersonation by input | Actor ignores input; RLS WITH CHECK |
| G10 | Sentinel content in unknown params field | Logger metadata-only |
| G11 | EVENT_TYPES snapshot | Unchanged at 2 values |
| G12 | Sole production path is classifier | Smoke test |
| G13 | **Static scan: zero consumer references outside writing path** | The canary — fails if any new code reads the new table outside the documented writing path |

Plus C-series snapshot updates:
- C2: REASONS grows from 12 to 13.
- C3: INTENT_TYPES grows from 9 to 10.
- C4: OUTCOMES grows from 5 to 6.

Integration suite (`tests/integration/execution-authorization.test.js`)
covers DB-side counterparts: self-authorization trigger raises,
rejected-review trigger raises, scope-mismatch trigger raises,
double-authorization UNIQUE raises, cross-pilot composite-FK
raises, non-admin RLS WITH CHECK raises, append-only trigger
raises, lylo_runtime GRANT denied.

## 10. Logging hygiene

The execution-authorization actor logs ONE event per recorded
authorization: `actor.execution_authorization.recorded` with
typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `authorization_id` (UUID)
- `review_decision_id` (UUID)
- `authorization_scope` (locked GM-25 vocabulary)
- `authorization_reason` (locked GM-25 vocabulary)
- `authorized_by_user_id` (UUID)
- `authorized_by_role` (admin)

No free-text content; no payload; no evidence. G10 plants a
sentinel in an unknown params field and asserts it never appears
in any captured log line.

## 11. Change control

Adding a new authorization_scope, a new authorization_reason, a
new authorizer role, an UPDATE / DELETE grant, an authorization
expiry / revocation column, or **any consumer of
`governance_execution_authorizations`** is a boundary change. It
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

When the change introduces a consumer of recorded authorizations,
the same PR MUST explicitly establish:
- whether the consumer is mounted,
- what its boundary guard is,
- what its adversarial review covers,
- what its OQ set looked like,
- how revocation, expiry, and replay protection are handled (none
  of those exist in GM-25; the consumer GM must introduce them
  before reading authorization rows for operational purposes).

A silent consumer is the failure mode this substrate is designed
to prevent. G13 is the canary.

## Cross-references

- `review-queue-runtime-boundary.md` — the GM-23 staging substrate.
- `review-decision-runtime-boundary.md` — the GM-24 review-outcome
  substrate this layer authorizes from.
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-25 with the fourth Decision-gated actor).
- `governance-runtime-boundary.md` — classifier + Decision shape
  (extended in GM-25 with one intent type + one reason).
- `rls-privacy-contract.md` — engaged RLS policies (extended in
  GM-25 with the new table policies).
- `baseline-ci.md` — CI guard set (review boundary guard
  extended).
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/execution-authorization-actor.js` — the actor.
- `../../db/migrations/010_execution_authorizations.sql` — the
  migration.
- `../../tests/integration/execution-authorization.test.js` —
  integration proof.
- `../../tests/governance/adversarial.test.js` — G-series
  negative tests (G13 = consumer-leak canary).
