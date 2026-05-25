# Execution-Verification Runtime Boundary

**Applies to:** the execution-verification substrate (`src/review/`
repository functions `recordExecutionVerification`,
`listExecutionVerifications`, `inspectExecutionVerification`;
the new `src/actors/execution-verification-ledger-actor.js`
actor; and the `governance_execution_verifications` table
created by `db/migrations/014_execution_verifications.sql`).
Introduced in GM-29 — the seventh persistence expansion since
the process lock, extending the GM-23 through GM-28
governance-staging chain with the **first** artifact that names
"checking" as a distinct governance act while explicitly
refusing to claim that the check was correct, repaired
anything, or had any operational consequence.

**Status:** locked. Changes go through a reviewed change to
this file and `scripts/ci/check-review-boundary.js` in the same
PR. Adding a new verifier role, an UPDATE path, relaxing any
CHECK constraint, widening `VERIFICATION_TYPES` beyond the four
channel names, widening `VERIFICATION_RESULTS` beyond the three
result values, OR allowing the `verified_*` prefix to escape
into any other substrate requires paired updates to this
document, the migration chain, the rls-contract synthetic
suite, the adversarial snapshot tests (C2/C3/C4/K37), and the
K-series in `tests/governance/adversarial.test.js`. **Removing
any of the four required sections (`## What this is NOT`,
`## What remains unresolved`, `## Verification is not
reconciliation`, `## Verification does not execute or repair`)
or the verbatim phrase `verification ≠ reconciliation ≠ repair`
fails the K27 doc-presence canary.**

**Depends on:** all prior staging substrate docs
(`review-queue-runtime-boundary.md`,
`review-decision-runtime-boundary.md`,
`execution-authorization-runtime-boundary.md`,
`execution-claim-runtime-boundary.md`,
`execution-attempt-runtime-boundary.md`,
`execution-outcome-runtime-boundary.md`),
`governance-runtime-boundary.md` (classifier + Decision shape
the actor consumes), `actor-runtime-boundary.md` (actor
contract), `rls-privacy-contract.md` (engaged RLS policies).

## Purpose

GM-28 made every reported outcome observable: each attempt
could acquire (at most) one outcome row recording what a human
observed about its apparent state. But the chain still had no
artifact at which a **separate** human could record that they
independently CHECKED the reported outcome — and so "what was
observed" and "what was verified" would inevitably collapse
into "what is true," which is exactly the truth claim the
substrate is not authorised to make.

GM-29 adds the smallest possible **independent-check** substrate:

- a different admin (not the outcome recorder) can **record
  what they observed** when verifying a reported outcome,
- the recorded verification is **immutable** and **append-only**,
- each outcome is verifiable **at most once**
  (`UNIQUE(execution_outcome_id)` — replay forbidden in GM-29
  per OQ-29.2),
- a verifier **cannot verify their own outcome row**
  (BEFORE-INSERT trigger),
- the verification_type names the **channel** used (human
  observation, system log review, database state check,
  external confirmation),
- the verification_result names the **result** (consistent,
  inconsistent, inconclusive),
- the underlying review_decision must still be `'approved'`
  (defense-in-depth chain walk, now seven layers deep).

The substrate is **inert**. It records. Nothing in GM-29 reads
verification rows operationally, executes anything, mutates
memory, schedules background work, notifies external systems,
or feeds back into the queue / decision / authorization / claim
/ attempt / outcome chain.

**Verifications are also OPTIONAL.** No outcome is required to
ever acquire a verification row, and the absence of a
verification row is NOT itself a verification result. Missing
verification rows remain structurally valid. Any policy that
interprets absence is OUTSIDE the GM-29 contract.

The constitutional rule (now applied at seven levels):

> **Approval is not authorization.**
> **Authorization is not execution.**
> **An authorization row is not an execution signal.**
> **A claim row is not execution — it only records single-consumption.**
> **An attempt row is not an outcome — it only records the beginning of an attempt.**
> **An outcome row is not truth — it only records what a human reported they observed.**
> **A verification row is not truth — it only records that a separate human independently CHECKED the report and what they observed through a named evidence channel.**

GM-29 records **independent checks**. It does NOT establish
canonical truth, repair anything, reconcile against anything,
or have any operational consequence.

verification ≠ reconciliation ≠ repair

## 1. Module placement

```
src/review/
  client.js          — unchanged
  log.js             — unchanged
  errors.js          — unchanged
  transaction.js     — extended: ctx exposes recordExecutionVerification,
                       listExecutionVerifications,
                       inspectExecutionVerification alongside the
                       GM-23/24/25/26/27/28 ops.
  repository.js      — extended: 3 new functions;
                       + VALID_VERIFICATION_TYPES Set (4 channel values)
                       + VALID_VERIFICATION_RESULTS Set (3 values,
                         `verified_*` prefix constitutionally isolated)
                       + VALID_VERIFIER_ROLES Set (admin only).
  index.js           — public surface unchanged.

src/actors/
  outcomes.js        — + OUTCOMES.VERIFICATION_RECORDED = 'verification_recorded'
  execution-verification-ledger-actor.js  — NEW (per OQ-29.9;
                       "ledger" in the filename is MANDATORY and is
                       the single most important architectural defense
                       at this layer against operational, fix-it, and
                       reconciliation drift).
  index.js           — + createExecutionVerificationLedgerActor

scripts/ci/check-review-boundary.js  — extended:
  - SELECT_ALLOWED_TABLES += 'governance_execution_verifications'
  - INSERT_ALLOWED_TABLES += 'governance_execution_verifications'
  - NEW: fourth file-scoped forbidden-vocabulary scan, using the
    shared FILE_SCOPED_SCANS / runFileScopedForbiddenScan helper.
    Bans 20 bare identifiers in
    `src/actors/execution-verification-ledger-actor.js`:
      Operational / repair (12):
        executed, dispatched, retry, retried, reconcile,
        reconciled, rollback, compensate, side_effect, mutate,
        promote, admit
      Fix-it temptation (8):
        fix, repair, correct, heal, resolve, revert, undo, apply
    Per OQ-29.10(b) modulo the owner-noted resolution that bare
    `execute` and `dispatch` are dropped to avoid collision with
    the actor contract method name. Past-tense forms are
    retained.

src/runtime/, src/db/, src/memory/, src/companion/,
src/conversation/, src/governance/  — src/governance/ widens
  vocabulary by exactly one INTENT_TYPES + one REASONS + one
  POLICY_REFS + one classifier branch. Every other module
  UNCHANGED.

docs/governance/execution-verification-runtime-boundary.md  — NEW (this doc).
db/migrations/014_execution_verifications.sql               — NEW.
```

## 2. Schema (`governance_execution_verifications`)

| Column | Type | Constraint |
|---|---|---|
| `id` | UUID | PK, default `gen_random_uuid()` |
| `pilot_instance_id` | UUID NOT NULL | FK → `pilot_instances(id)` |
| `execution_outcome_id` | UUID NOT NULL | composite FK + UNIQUE on its own |
| `verified_by_user_id` | UUID NOT NULL | composite FK |
| `verified_by_role` | TEXT NOT NULL | CHECK `= 'admin'` |
| `verification_type` | TEXT NOT NULL | **CHECK locked to the 4 channel values** |
| `verification_result` | TEXT NOT NULL | **CHECK locked to the 3 values** |
| `created_at` | TIMESTAMPTZ NOT NULL | default `now()` |
| — | — | `UNIQUE (execution_outcome_id)` — at most one verification per outcome |
| — | — | `UNIQUE (pilot_instance_id, id)` — for future composite-FK targets |
| — | — | composite FK `(pilot_instance_id, verified_by_user_id)` → `users` |
| — | — | composite FK `(pilot_instance_id, execution_outcome_id)` → `governance_execution_outcomes` |

**The `verification_type` CHECK** is locked at the database
level to exactly four channel values:

- `human_observation`
- `system_log_review`
- `database_state_check`
- `external_confirmation`

**The `verification_result` CHECK** is locked at the database
level to exactly three result values:

- `verified_consistent`
- `verified_inconsistent`
- `verification_inconclusive`

The `verified_*` prefix is a **constitutional boundary, not a
naming style**. It is permitted IN THIS TABLE ONLY. K37 snapshot
asserts the prefix does NOT leak into `EXECUTION_OUTCOME_TYPES`.
Adding `verified_succeeded`, `verified_failed`, or any non-
listed value requires the four-fold update above AND a decision
gate that explicitly addresses the truth-claim ring.

**Deliberately EXCLUDED `verification_result` values:**
`verified_succeeded` / `verified_failed` (would smuggle truth
claims via verification); `verification_refused` (refusal-to-
verify is a separate decision gate); `verified_repaired` /
`verified_corrected` / `verified_fixed` (correction is a
separate future ring; K24 mechanically forbids these vocabulary
fragments anywhere in the ledger actor file).

**Deliberately EXCLUDED `verification_type` values:**
`automated_check` (automation-as-verifier is a separate
decision gate with its own actor-identity, audit, and
authorization model).

**No `verification_basis` column** (per OQ-29.3(d) +
constitutional addendum 7). GM-29 stores governance metadata
only — no evidence payloads, no raw logs, no screenshots, no
URLs, no notes, no free-form verifier narratives. The basis
question is a separate decision gate with its own privacy +
retention contract.

**Mutation prevention — three independent walls:**
1. BEFORE-UPDATE-OR-DELETE trigger raises on any attempt.
2. No UPDATE or DELETE GRANT exists for any role.
3. No RLS policy could permit the operation even if a grant were added.

**Preconditions BEFORE-INSERT trigger** walks the 7-deep chain
verification → outcome → attempt → claim → authorization →
review_decision and enforces three invariants:

| # | Check | Catches |
|---|---|---|
| (a) | outcome exists in same pilot | nonexistent / cross-pilot reference |
| (b) | `outcome.recorded_by_user_id ≠ verification.verified_by_user_id` | self-verification |
| (c) | `review_decision.review_outcome = 'approved'` (full chain walk) | chain rot |

## 3. RLS policies

Two policies on `governance_execution_verifications`:

- **`verification_insert_admin`** (INSERT WITH CHECK) — tenant
  match AND `verified_by_user_id = current_setting('app.user_id')`
  AND `current_setting('app.user_role') = 'admin'`.
- **`verification_admin_select`** (SELECT) — tenant match AND
  `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant / attempter /
recorder / verifier-as-non-admin / family / caregiver / runtime
SELECT policy.** Verifications are admin-only governance metadata.

**No UPDATE / DELETE policy.**

## 4. Locked vocabularies

GM-29 introduces **two** new locked vocabularies at the
substrate layer:

| Set | Where | Values |
|---|---|---|
| `VERIFICATION_TYPES` | `src/review/repository.js` as `VALID_VERIFICATION_TYPES`; mirrored in the migration CHECK | `human_observation`, `system_log_review`, `database_state_check`, `external_confirmation` |
| `VERIFICATION_RESULTS` | `src/review/repository.js` as `VALID_VERIFICATION_RESULTS`; mirrored in the migration CHECK | `verified_consistent`, `verified_inconsistent`, `verification_inconclusive` |

Inherited unchanged:

- `verified_by_role` — CHECK-locked to `'admin'`.

The trigger enforces self-verification rejection and chain
integrity. CHECKs enforce vocabulary integrity.

**Why exactly these four `verification_type` values:**

| Value | Semantic |
|---|---|
| `human_observation` | Verifier looked. |
| `system_log_review` | Verifier read a log. |
| `database_state_check` | Verifier queried a separate store. |
| `external_confirmation` | Verifier obtained an independent attestation. |

**Why exactly these three `verification_result` values:**

| Value | Semantic |
|---|---|
| `verified_consistent` | Verifier observed what they expected, given the report. NOT a truth claim. |
| `verified_inconsistent` | Verifier observed something that did NOT match the report. NOT a "failure" or "broken" claim. |
| `verification_inconclusive` | Verifier could not establish consistency either way. NOT "retry", NOT "escalate", NOT "someone must act." |

## 5. Public API surface (post-GM-29)

| Export | Status |
|---|---|
| `createReviewQueuePool(databaseUrl, options?)` | unchanged from GM-23 |
| `closeReviewQueuePool(handle)` | unchanged |
| `withReviewContext(handle, sessionCtx, fn)` | unchanged signature; ctx now exposes **nineteen** operations |
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
| `ctx.recordExecutionOutcome(input)` | GM-28 |
| `ctx.listExecutionOutcomes({limit?})` | GM-28 |
| `ctx.inspectExecutionOutcome(outcomeId)` | GM-28 |
| `ctx.recordExecutionVerification(input)` | GM-29 NEW |
| `ctx.listExecutionVerifications({limit?})` | GM-29 NEW |
| `ctx.inspectExecutionVerification(verificationId)` | GM-29 NEW |

Public actor factories from `src/actors`:

| Factory | Status |
|---|---|
| `createResponseDeliveryActor` | GM-22 |
| `createReviewQueueActor` | GM-23 |
| `createReviewDecisionActor` | GM-24 |
| `createExecutionAuthorizationActor` | GM-25 |
| `createExecutionClaimLedgerActor` | GM-26 |
| `createExecutionAttemptLedgerActor` | GM-27 |
| `createExecutionOutcomeLedgerActor` | GM-28 |
| `createExecutionVerificationLedgerActor` | GM-29 NEW |
| `OUTCOMES` enum | extended: 10-way (`verification_recorded` added) |

## 6. Decision-verification chain (nine layers)

The execution-verification ledger actor mirrors the GM-26/27/28
ledger actors' verification chain shape, adjusted for the
vocabulary preconditions:

1. `instanceof Decision`
2. `isValidDecision` (WeakSet)
3. `Object.isFrozen(decision)`
4. `decision.intentType === GOVERNANCE_EXECUTION_VERIFY`
5. Structural revalidation (REASONS, non-empty `policyRef`)
6. `decision.decision === ADMISSIBLE`
7. `params.userRole === 'admin'`
8. `params.verificationType ∈ VERIFICATION_TYPES`
9. `params.verificationResult ∈ VERIFICATION_RESULTS`

Plus UUID validation on `pilotInstanceId` / `userId` /
`executionOutcomeId`. The actor rejects smuggled vocabulary
(`verified_succeeded`, `verified_failed`, `verified_completed`,
`reported_completed`, uppercase variants) BEFORE opening a
connection.

The **three DB-side data preconditions** (outcome exists;
verifier ≠ recorder; chain walks to approved) are NOT
duplicated at the actor — they live in the BEFORE-INSERT
trigger.

## 7. Boundary guard rules

`scripts/ci/check-review-boundary.js` (extended for GM-29):

| Rule | Why |
|---|---|
| `UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE` in any `src/review/` `.js` file | Append-only semantics. |
| FROM/JOIN allowlist += `governance_execution_verifications` | Read access for `listExecutionVerifications` / `inspectExecutionVerification`. |
| INSERT INTO allowlist += `governance_execution_verifications` | Write access for `recordExecutionVerification`. |
| **File-scoped (NEW for GM-29):** 20 words forbidden in `src/actors/execution-verification-ledger-actor.js` — 12 operational/repair words + 8 fix-it temptation words | Mechanical enforcement of VERIFICATION ≠ RECONCILIATION ≠ REPAIR. |

The file-scoped scan logic remains the shared
`runFileScopedForbiddenScan` helper (introduced in GM-27 per
OQ-27.17); GM-29 adds a fourth `FILE_SCOPED_SCANS` entry.

## 8. Impossibility guarantees

| Property | Enforced by |
|---|---|
| Recording a verification does the thing the verification is "for" | No consumer exists; K22 static-scan canary asserts; doc forbids. |
| Recording a verification mutates a prior row | All seven tables are append-only; module writes only to the new table. |
| Verifying an outcome the same human recorded | BEFORE-INSERT trigger + composite-FK chain. |
| Recording twice against the same outcome | `UNIQUE(execution_outcome_id)` — replay forbidden in GM-29. |
| Cross-pilot verification | Composite FK + RLS WITH CHECK. |
| Smuggling success / failure as a "verified_" value | `VALID_VERIFICATION_RESULTS` Set + DB CHECK + K37 snapshot all reject `verified_succeeded` / `verified_failed`. |
| Smuggling outcome vocabulary | DB CHECK rejects `reported_completed`; K37 enforces vocabulary isolation. |
| Letting `verified_*` leak into `EXECUTION_OUTCOME_TYPES` | K37 snapshot asserts no outcome value starts with `verified_`. |
| Non-admin recording a verification | RLS WITH CHECK (admin role) + actor layer 7. |
| Verifier impersonation via input | Actor sources `verified_by_user_id` from session context only; RLS WITH CHECK matches against `app.user_id`. |
| Mutating a recorded verification | Append-only trigger + no UPDATE/DELETE grants. |
| Operational, repair, or fix-it vocabulary creeping into the actor file | K24 + boundary guard file-scoped forbidden-vocabulary scan (20 words). |
| The boundary doc loses any of its 4 required sections or the verbatim phrase | K27 doc-presence canary asserts all 5 markers persist. |
| EVENT_TYPES widening | None. The verifications table IS the artifact. K15 adversarial asserts the lock. |

## 9. Adversarial review additions (K-series)

`tests/governance/adversarial.test.js` extended:

| # | Probe | Defense |
|---|---|---|
| K1 | Plain-object Decision | Layer 1 |
| K2 | Prototype-tampered Decision | Layer 2 |
| K3 | Wrong intent type (outcome.record) | Layer 4 |
| K5 | Non-admin role | Layer 7 |
| K14 | Sentinel content in unknown params field | Logger metadata-only |
| K15 | EVENT_TYPES snapshot | Unchanged at 2 values |
| **K22** | **Static scan: zero references outside writing path** | Canary against accidental consumer introduction (constitutional addendum 3) |
| **K24** | **File-scoped forbidden-vocabulary scan on the ledger actor** | 20 words (12 operational/repair + 8 fix-it temptation) |
| **K27** | **Doc-presence canary** — 4 required sections + verbatim phrase | Defends the future-conflict-resolution GM against silent removal |
| **K37** | **`VERIFICATION_TYPES` + `VERIFICATION_RESULTS` snapshots + `verified_*` isolation** | Constitutional canary: smuggled `verified_succeeded` / `verified_completed` / leakage into outcome vocabulary fails immediately |

Plus C-series snapshot updates:
- C2: REASONS grows from 16 to 17.
- C3: INTENT_TYPES grows from 13 to 14.
- C4: OUTCOMES grows from 9 to 10.

## 10. Logging hygiene

The execution-verification ledger actor logs ONE event per
recorded verification: `actor.execution_verification.recorded`
with typed metadata only:

- `intent_type` (locked classifier vocabulary)
- `decision` (locked DECISION_OUTCOMES — always `admissible`)
- `reason` (locked REASONS)
- `verification_id` (UUID)
- `execution_outcome_id` (UUID)
- `verification_type` (locked GM-29 vocabulary)
- `verification_result` (locked GM-29 vocabulary)
- `verified_by_user_id` (UUID)
- `verified_by_role` (admin)

No free-text content; no payload; no verifier notes; no
verification_basis (the column does not exist). No operational
/ repair / fix-it markers — those words are mechanically
forbidden in this file. K14 plants a sentinel in unknown params
fields (including `verificationBasis`, `payload`, `notes`) and
asserts it never appears in any captured log line.

## What this is NOT

GM-29's verification artifact records ONLY that a verifier
independently checked a reported outcome and what they observed
through a named evidence channel. It is NOT, and must never
become:

- **truth**
- **canonical state**
- **a fact** (it is a check, not a verdict)
- **success** (`verified_succeeded` is forbidden)
- **failure** (`verified_failed` is forbidden)
- **a repair signal** (K24 forbids `fix` / `repair` / `correct` / `heal`)
- **a retry trigger** (K24 forbids `retry` / `retried`)
- **a reconciliation trigger** (K24 forbids `reconcile` / `reconciled`)
- **a rollback or compensation primitive** (K24 forbids `rollback` / `compensate` / `revert` / `undo`)
- **a promotion or admission signal** (K24 forbids `promote` / `admit`)
- **an automated check** (`automated_check` is excluded from `VERIFICATION_TYPES`; automation-as-verifier is a separate decision gate)
- **a refusal-to-verify** (`verification_refused` is excluded; refusal is a separate decision gate)
- **an evidence store** (no `verification_basis` column exists; the basis question is a separate decision gate with its own privacy + retention contract)
- **a side-effect surface** (K24 forbids `side_effect`)
- **a mutation primitive** (K24 forbids `mutate` / `apply`)
- **a workflow state** (there are no state transitions; the row exists or it does not)
- **a default** (`verification_inconclusive` is an affirmative observation that consistency could not be established, NOT a placeholder)
- **an aggregate signal** (no policy may treat counts of `verified_consistent` rows as a "verification rate")

Verifications are also **OPTIONAL**. An outcome may exist
forever with no verification row, and **the absence of a
verification row is NOT itself a verification result** — it is
silence. Any policy that treats absence as a signal is OUTSIDE
the GM-29 contract and must be its own decision gate.

The `verified_*` prefix on the result vocabulary is a
structural defense, not a naming convention. The prefix is
permitted IN THE VERIFICATION TABLE ONLY. K37 mechanically
asserts the prefix does NOT appear in `EXECUTION_OUTCOME_TYPES`.

Any future code that consumes verification rows for operational
purposes — i.e., to decide what to do next based on whether a
verification row exists or what its `verification_result` says
— is OUTSIDE the GM-29 contract and must be its own decision
gate. K22 mechanically asserts zero such consumers exist
(constitutional addendum 3).

The actor file is mechanically forbidden by K24 +
`check-review-boundary.js` from containing any of the 20 bare
identifiers: `executed` / `dispatched` / `retry` / `retried` /
`reconcile` / `reconciled` / `rollback` / `compensate` /
`side_effect` / `mutate` / `promote` / `admit` / `fix` /
`repair` / `correct` / `heal` / `resolve` / `revert` / `undo` /
`apply`.

## What remains unresolved

GM-29 deliberately refuses to answer the following questions.
The future-conflict-resolution / verification-evidence /
authoritative-state GM (whenever it is approved, with its own
OQ set) MUST address each of them explicitly. The K27
doc-presence canary asserts this section remains in the doc so
the warning is not silently removed.

1. **Authoritative state.** Is there ever a downstream artifact
   that asserts what is canonically true given a set of
   verification rows? GM-29 ships no such artifact.
   `verified_consistent` ≠ "true"; `verified_inconsistent` ≠
   "false"; `verification_inconclusive` ≠ "still unknown — go
   look again." Authoritative state is a separate decision gate.

2. **Missing-verification semantics.** Is the absence of a
   verification row itself a verification result? GM-29 says
   no. Until then, no consumer may treat "no row" as a signal.

3. **Disagreement between verifiers.** GM-29 enforces
   `UNIQUE(execution_outcome_id)`, so two admins cannot record
   conflicting verifications against the same outcome. What
   happens when two admins disagree about what they checked?
   The current substrate makes the second verifier lose
   structurally. Future GMs may need to introduce a contention
   primitive — that is a separate decision.

4. **Disagreement between verifier and recorder.** If the
   outcome is `reported_completed` and the verification is
   `verified_inconsistent`, what — if anything — happens? In
   GM-29: nothing. The two rows simply both exist, both
   visible to admins, with no downstream consumer reading
   either. Operationalising this conflict is a separate
   decision gate.

5. **Aggregate / analytic use.** May `verification_result` ever
   be aggregated (counts, ratios, dashboards)? GM-29 takes no
   position; the substrate is admin-only and any analytic
   surface is a separate decision gate. An aggregation that
   treats `verified_consistent` as a "verification rate" would
   smuggle the truth claim the substrate refuses to make.

6. **Verification evidence / `verification_basis`.** GM-29
   deliberately omits a basis column. If a future GM needs to
   store the actual evidence (log excerpts, screenshots, query
   results, attestation documents), that GM MUST first design
   the privacy contract, retention contract, redaction
   discipline, size limits, sentinel-scan canaries, and
   visibility model for evidence content. Adding the column
   without those is the failure mode this exclusion exists to
   prevent.

7. **Automated verification.** GM-29 deliberately excludes
   `automated_check`. If a future GM introduces a machine
   verifier, that GM MUST design the actor-identity model (what
   is the machine's `verified_by_user_id`?), the audit model
   (how is the automation's verification distinguished from a
   human's at audit time?), and the authorization model (which
   automations are authorised to verify which outcomes?).

8. **Time windows.** Is there a deadline by which a
   verification must be recorded? Does an outcome with no
   verification after N minutes / hours / days flip to any
   state? GM-29 has no expiry, no timeouts, no scheduler. Any
   such window is a separate decision gate.

9. **Revisions / corrections.** GM-29 forbids UPDATE/DELETE
   and forbids a second verification row per outcome. If a
   future GM needs to correct a misrecorded verification, how?
   GM-29 provides no answer; correction is a separate decision
   gate.

10. **Cascading verification.** If a future GM introduces a
    verifying-the-verifier ring (so an admin7 can check what
    admin6 observed), that GM MUST decide whether such checks
    consume verification rows, produce new verification rows
    against the verification rows, or live in a separate
    substrate entirely. GM-29 takes no position.

11. **Privacy boundary.** Verifications are admin-only. If a
    future GM exposes verification data to non-admin surfaces,
    the privacy model needs explicit re-derivation. GM-29
    makes no such exposure.

12. **Pre-verification-GM rows.** If a future GM introduces a
    canonical-state ring, how are existing verification rows
    (recorded before that GM landed) interpreted? GM-29 takes
    no position.

The next governance decision gate that introduces canonical
state, conflict resolution, evidence storage, automated
verification, an aggregation surface, a correction primitive,
OR any consumer of verification rows MUST start by enumerating
which of these twelve questions it is answering and which it
is deferring further. A silent answer to any of them is the
failure mode this section exists to prevent.

## Verification is not reconciliation

The verification ring records WHAT a verifier observed. It
does NOT, and must never become, a mechanism for **bringing
the world's state into agreement with the reported outcome**,
nor for **bringing the reported outcome into agreement with
the world's state**. Both directions of reconciliation are
explicitly excluded.

Reconciliation requires:
- a canonical source of truth to reconcile against,
- a rule for which side wins on conflict,
- a primitive for changing the losing side's state,
- a primitive for retrying when reconciliation fails,
- a primitive for compensating partial work,
- and a contract for what happens when reconciliation itself
  fails.

GM-29 has none of these. The actor file is mechanically
forbidden by K24 from containing `reconcile` / `reconciled` /
`rollback` / `compensate` / `retry` / `retried` as bare
identifiers. Any future GM that introduces reconciliation
semantics MUST address each of the six requirements above
explicitly, with its own decision gate.

A verification row whose `verification_result` is
`verified_inconsistent` is NOT a reconciliation request. It is
an observation. What — if anything — to do about that
observation is a separate decision.

## Verification does not execute or repair

A verification row records OBSERVATION. It does NOT, and must
never become, a mechanism for **doing anything to anything**.
The actor file is mechanically forbidden by K24 from containing
`executed` / `dispatched` / `mutate` / `promote` / `admit` /
`fix` / `repair` / `correct` / `heal` / `resolve` / `revert` /
`undo` / `apply` / `side_effect` as bare identifiers.

Repair requires:
- a definition of what the "correct" state is,
- a primitive for transitioning state,
- an authorization model for who may transition,
- an audit model for the transition,
- and a rollback model for if the transition itself fails.

GM-29 has none of these. A verification row whose
`verification_result` is `verified_inconsistent` is NOT a
repair request. It is an observation. What — if anything — to
do about that observation is a separate decision.

Even the most innocuous-looking convenience would be a
violation: a function that takes a verification row and
"applies" its implication, "resolves" a discrepancy, "fixes"
the underlying state, or "promotes" an outcome to a verified
status — any of those is execution / repair / mutation under
governance terms, and is OUTSIDE the GM-29 contract.

## 11. Change control

Adding a new verifier role, an UPDATE / DELETE grant, a
verification revocation column, a fifth `verification_type`
value, a fourth `verification_result` value, **any consumer of
`governance_execution_verifications`**, OR any new vocabulary
that escapes the constitutional isolation of `verified_*` is a
boundary change. It requires a reviewed change to:

- this document,
- `db/migrations/0NN_*.sql` (next number),
- `tests/rls-contract/synthetic-schema.sql`,
- `tests/rls-contract/policies.sql`,
- `tests/rls-contract/fixtures.sql`,
- `tests/rls-contract/run-contract.js`,
- `tests/rls-contract/run-real.test.js`,
- `tests/governance/adversarial.test.js` (snapshot + new probes; K37 in particular),
- `scripts/ci/check-review-boundary.js` if read/write
  allowlists or the file-scoped forbidden-vocabulary list shifts,
- `src/governance/intents.js` / `decisions.js` / `classifier.js`
  if new vocabulary lands,
- `src/review/repository.js` if `VALID_VERIFICATION_TYPES` or
  `VALID_VERIFICATION_RESULTS` shifts.

When the change introduces a consumer of recorded
verifications, the same PR MUST explicitly answer every
question enumerated in "What remains unresolved" above. Silent
answers fail process.

When the change introduces reconciliation, repair, correction,
canonicalization, retry, rollback, compensation, or any
operational consequence of a `verification_result`, the same
PR MUST explicitly retire or refactor the K24 forbidden-
vocabulary scan AND the K27 doc-presence canary, justifying
why the constitutional separation of observation from action
is no longer required. Both are the constitutional defense;
removing them without replacement is a process failure.

## Cross-references

- `review-queue-runtime-boundary.md` — GM-23 staging substrate.
- `review-decision-runtime-boundary.md` — GM-24 review-outcome
  substrate.
- `execution-authorization-runtime-boundary.md` — GM-25
  authorization substrate.
- `execution-claim-runtime-boundary.md` — GM-26 claim substrate.
- `execution-attempt-runtime-boundary.md` — GM-27 attempt
  substrate.
- `execution-outcome-runtime-boundary.md` — GM-28 outcome
  substrate (this layer verifies against).
- `actor-runtime-boundary.md` — the actor contract (extended in
  GM-29 with the eighth Decision-gated actor, §4g).
- `governance-runtime-boundary.md` — classifier + Decision
  shape (extended in GM-29 with one intent type + one reason,
  §6h).
- `rls-privacy-contract.md` — engaged RLS policies.
- `baseline-ci.md` — CI guard set.
- `../../scripts/ci/check-review-boundary.js` — the guard.
- `../../src/review/` — the module.
- `../../src/actors/execution-verification-ledger-actor.js` —
  the actor.
- `../../db/migrations/014_execution_verifications.sql` — the
  migration.
- `../../tests/integration/execution-verification.test.js` —
  integration proof.
- `../../tests/governance/adversarial.test.js` — K-series
  negative tests (K22 = consumer-leak canary; K24 = forbidden
  operational + repair + fix-it vocabulary; K27 = doc-presence
  canary; K37 = `VERIFICATION_TYPES` + `VERIFICATION_RESULTS`
  snapshots + `verified_*` isolation).
