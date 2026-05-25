# Actor-Runtime Boundary

**Applies to:** the actor-runtime module in `src/actors/` — the
first code outside `src/governance/` that consumes a
classifier-produced Decision and acts on it. Introduced in GM-22;
extended in GM-23 to add a second Decision-gated actor (the
review-queue actor).
**Status:** locked. Changes go through a reviewed change to this
file and `scripts/ci/check-actors-boundary.js` in the same PR.
Adding a new actor (or relaxing the import allowlist) requires a
paired update to this document.
**Depends on:** `governance-runtime-boundary.md` (the
classifier and Decision shape this layer consumes);
`conversation-runtime-boundary.md` (the only downstream
capability GM-22's actor wraps);
`review-queue-runtime-boundary.md` (the GM-23 substrate the
review-queue actor stages into); `companion-runtime-boundary.md`
and `memory-runtime-boundary.md` (orthogonal — neither GM-22's
nor GM-23's actor imports either).

## Purpose

GM-21 introduced the execution-decision classifier and the
opaque `Decision` class. The classifier said: "future actors
will require a `Decision` instance — they cannot act on a raw
intent." Until GM-22, that contract was documented but not
mechanically enforced.

GM-22 ships the **first actor**. The actor's existence is the
first mechanical proof that "you cannot act without a Decision":

- The actor's `execute(decision, params)` method requires a
  `Decision` as its first argument.
- A multi-layer verification chain (described in §3) rejects
  forged, tampered, mismatched-intent-type, or vocabulary-invalid
  Decisions.
- On a verified-but-not-admissible Decision, the actor returns a
  structured abstained/rejected outcome WITHOUT calling the
  downstream runtime.

The downstream runtime (the GM-20 conversation runtime) is still
independently callable in GM-22 (OQ-22.8 — no API break). A
future GM may close the direct-caller seam; until then, the
actor is the recommended path.

## 1. Module placement

```
src/runtime/      — config loader; never imports actors/.
src/db/           — runtime pool; never imports actors/.
src/memory/       — memory library; never imports actors/.
src/companion/    — read-only consumer; never imports actors/.
src/conversation/ — single-shot model runtime; never imports
                    actors/. (The actor wraps the runtime, not the
                    other way around.)
src/governance/   — pure classifier (leaf); never imports actors/.
src/actors/       — GM-22: first Decision-gated executor
                    (response-delivery actor wrapping the
                    conversation runtime). GM-23: second
                    Decision-gated executor (review-queue actor
                    wrapping the GM-23 review-queue substrate).
                    Imports `../governance` (public entry only,
                    for the Decision contract), `../conversation`
                    (public entry only — response-delivery actor),
                    and `../review` (public entry only — review-
                    queue actor). NO pg, NO model SDKs (including
                    @anthropic-ai/sdk — that boundary belongs to
                    the conversation runtime), NO HTTP frameworks,
                    NO scheduling (other than transitive setTimeout
                    via the runtime), NO fs writes, NO subprocesses,
                    NO worker threads. Guarded by
                    check-actors-boundary.js.
```

Future GMs that introduce additional actors (e.g. a memory-
candidate actor) will add new files under `src/actors/` or
sub-directories. Each new actor gets its own intent-type contract
and may extend the boundary guard's allowed-import list (e.g. to
permit `../memory` entry imports). Every such extension is a
deliberate boundary change.

## 2. Public API surface (GM-22 through GM-29)

| Export | Purpose |
|---|---|
| `createResponseDeliveryActor({conversationRuntime, log?})` | GM-22. Factory. Returns a frozen actor with exactly one method, `execute(decision, params)`. |
| `createReviewQueueActor({reviewQueuePool, log?})` | GM-23. Stages `requires_review` Decisions into `governance_review_queue`. |
| `createReviewDecisionActor({reviewQueuePool, log?})` | GM-24. Records a human admin's review outcome (`approved` \| `rejected`) against a pending queue item, into `governance_review_decisions`. **Admin role only.** Recording is NOT execution; approval is NOT authorization. |
| `createExecutionAuthorizationActor({reviewQueuePool, log?})` | GM-25. Records an admin's explicit authorization against an approved review_decision, into `governance_execution_authorizations`. **Admin role only**; **authorizer ≠ reviewer**; **scope must match underlying intent type**; review must be **approved**. Authorization is NOT execution; an authorization row is NOT an execution signal. |
| `createExecutionClaimLedgerActor({reviewQueuePool, log?})` | GM-26. Records an admin's explicit single-consumption claim of an authorization for a specific future execution surface, into `governance_execution_claims`. **Admin role only**; **claimant ≠ authorizer**; **scope equality with authorization**; **surface ↔ scope 1:1 mapping**; underlying review must still be **approved**. `UNIQUE(execution_authorization_id)` is the **replay-prevention wall**. Claim is NOT execution; claim is NOT dispatch; claim is NOT completion; claim is NOT success. |
| `createExecutionAttemptLedgerActor({reviewQueuePool, log?})` | GM-27. Records that an admin BEGAN an execution attempt against a claim, into `governance_execution_attempts`. **Admin role only**; **attempter ≠ claimant**; **scope equality with claim**; **surface equality with claim**; underlying review must still be **approved**. `UNIQUE(execution_claim_id)` forbids retry / multi-attempt. **ATTEMPT IS NOT OUTCOME** — records ONLY the beginning of an attempt; never success, failure, completion, interruption, delivery, dispatch, finalization, or commit. |
| `createExecutionOutcomeLedgerActor({reviewQueuePool, log?})` | GM-28. Records that an admin OBSERVED an apparent end state for a recorded attempt, into `governance_execution_outcomes`. **Admin role only**; **recorder ≠ attempter**; **scope equality with attempt**; **surface equality with attempt**; underlying review must still be **approved**. `UNIQUE(execution_attempt_id)` forbids replay. `outcome_type` is CHECK-locked to the 4 `reported_*` values. **AN OUTCOME ROW IS NOT TRUTH** — `reported_completed` ≠ `verified_completed`; the `reported_*` prefix is a constitutional defense, not a naming convention. Outcomes are OPTIONAL; absence is NOT itself an outcome. |
| `createExecutionVerificationLedgerActor({reviewQueuePool, log?})` | GM-29. Records that a separate admin independently CHECKED a reported outcome, into `governance_execution_verifications`. **Admin role only**; **verifier ≠ recorder**; underlying review must still be **approved**. `UNIQUE(execution_outcome_id)` forbids replay. `verification_type` is CHECK-locked to 4 channel values; `verification_result` is CHECK-locked to 3 values with the `verified_*` prefix constitutionally isolated to this table. **VERIFICATION ≠ RECONCILIATION ≠ REPAIR** — `verified_consistent` ≠ truth; `verification_inconclusive` ≠ retry / escalate / "someone must act." Verifications are OPTIONAL; absence is NOT itself a verification result. No `verification_basis` field — GM-29 stores governance metadata only. |
| `OUTCOMES` | Frozen `{EXECUTED, ABSTAINED, REJECTED, STAGED, RECORDED, AUTHORIZED_RECORDED, CLAIM_RECORDED, ATTEMPT_RECORDED, OUTCOME_RECORDED, VERIFICATION_RECORDED}` enum. `VERIFICATION_RECORDED` is the GM-29 addition; the ten-way set is snapshot-locked in the adversarial suite (C4). |

Internal helpers (`verifyDecisionOrThrow`, `validateParams`,
`isConversationRuntime`, `isReviewQueuePool`) are NOT re-exported
through `src/actors/index.js`. Each returned actor exposes only
`execute`.

## 3. Decision-verification chain (the central GM-22 contract)

Every call to `actor.execute(decision, params)` runs the
following verification on `decision` BEFORE any downstream work
(OQ-22.3):

| # | Check | Catches |
|---|---|---|
| 1 | `decision instanceof Decision` | Plain-object duck-types, primitives, null/undefined, arrays, functions. |
| 2 | `isValidDecision(decision)` (consults the classifier's module-private WeakSet) | **Prototype-tampering forgery.** An attacker can construct a `{intentType, decision, reason, policyRef}` shape, call `Object.setPrototypeOf(fake, Decision.prototype)` and `Object.freeze(fake)`. The result passes `instanceof Decision` AND `Object.isFrozen`. The WeakSet check rejects it because the fake was never added by `_createDecision` — only the classifier's path adds to the set. |
| 3 | `Object.isFrozen(decision)` | A genuine Decision that somehow got mutated (this should be impossible — the classifier freezes it — but defense in depth). |
| 4 | `decision.intentType === INTENT_TYPES.RESPONSE_DELIVER` | Type confusion. The response-delivery actor refuses Decisions for any other intent type (e.g. a real `memory.candidate.create` Decision will not pass). |
| 5 | `decision.decision ∈ DECISION_OUTCOMES` AND `decision.reason ∈ REASONS` AND `decision.policyRef` is a non-empty string | Vocabulary drift. Redundant with the Decision constructor's own checks; defense in depth in case a future refactor weakens them. |

**Failure mode: THROW.** Any verification failure throws a
descriptive Error. A forged or tampered Decision indicates broken
caller code, not a classification result — the caller should not
be able to "handle" this with a structured outcome. The runtime
is not consulted on any failure path.

The closes-prototype-tampering check (rule 2) is the GM-22
addition to GM-21's Decision shape. `isValidDecision` is exported
from `src/governance/index.js`; the underlying WeakSet is
private to `src/governance/decisions.js`.

## 4. Outcome routing (OQ-22.4)

After verification, the actor routes by `decision.decision`:

| `decision.decision` | Action | Outcome shape |
|---|---|---|
| `admissible` | Calls `conversationRuntime.respond(params)` exactly once | `{outcome: 'executed', decision, response, memoryCount}` |
| `requires_review` | Does NOT call the runtime | `{outcome: 'abstained', decision}` |
| `inadmissible` | Does NOT call the runtime | `{outcome: 'rejected', decision}` |

All three outcome shapes are `Object.freeze`d.

A note on the GM-22 actor specifically: the GM-21 classifier
returns `admissible` for `response.deliver`, period. There is no
classification path that yields `requires_review` or
`inadmissible` for `response.deliver`. The abstained/rejected
branches in the actor are therefore **defense in depth** — they
guarantee correct behavior if a future classifier change starts
returning non-admissible outcomes for `response.deliver`, AND
they make the contract visible for future actors that handle
intent types with richer outcome spaces.

### 4a. The review-queue actor (GM-23) — sixth verification layer

The review-queue actor extends the five-layer chain with a
**sixth, actor-specific** layer:

| # | Check | Catches |
|---|---|---|
| 6 | `decision.decision === DECISION_OUTCOMES.REQUIRES_REVIEW` | Staging the wrong kind of Decision. Admissible Decisions belong with the response-delivery actor (or its future siblings); inadmissible Decisions get recorded and dropped by their caller. Only `requires_review` belongs in the queue. |

The intent-type check (layer 4) is also different for the review-
queue actor. Unlike the response-delivery actor, which locks
`decision.intentType` to `RESPONSE_DELIVER`, the review-queue
actor accepts **any** value from `INTENT_TYPES` — any intent
type can in principle be classified `requires_review`, and the
queue stages all of them.

Outcome routing for the review-queue actor:

| `decision.decision` | Action | Outcome shape |
|---|---|---|
| `requires_review` (only) | One INSERT into `governance_review_queue` via `withReviewContext` | `{outcome: 'staged', decision, queueEntryId, createdAt}` |
| `admissible` | THROW (layer 6 rejects — does not call the substrate) | — |
| `inadmissible` | THROW (layer 6 rejects — does not call the substrate) | — |

The substrate's RLS policies (`tenant + no-impersonation`) are
the **outer** correctness gate. The actor's verification is
defense-in-depth for upstream callers; the database refuses
forged inserts even if the actor were bypassed entirely. See
`review-queue-runtime-boundary.md` for the full substrate
contract.

### 4b. The review-decision actor (GM-24) — seventh verification layer

The review-decision actor extends the chain with an actor-
specific **seventh** layer and a different layer-4 lock:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE` | Wrong intent type (response.deliver / memory.* / vault.* / external.* / governance.review.decide is the only admit) |
| 6 | `decision.decision === DECISION_OUTCOMES.ADMISSIBLE` | Outcome confusion — the classifier always returns admissible for this intent type; this is defense in depth |
| 7 | `params.userRole === 'admin'` | Non-admin recording a review outcome. Rejected BEFORE any DB call. The actor is the early-failure gate; RLS WITH CHECK is the authoritative wall. |

Plus parameter validation: `reviewQueueId` UUID-shaped;
`reviewOutcome ∈ ('approved','rejected')`; `reviewReason ∈`
the locked 5-value vocabulary. Vocabulary CHECKs at the DB layer
are the authoritative wall.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All seven verification layers + param validation pass | One INSERT into `governance_review_decisions` via `withReviewContext` | `{outcome: 'recorded', decision, reviewDecisionId, reviewedAt}` |
| Any failure | THROW (before any DB call) | — |

The substrate is defended four ways at the DB layer (RLS
WITH CHECK on admin + tenant + no-impersonation; composite FKs;
BEFORE-INSERT self-review trigger; UNIQUE on `review_queue_id`).
The actor's role/vocabulary checks are early-failure
defense-in-depth; the trigger and constraints are
unbypassable. See `review-decision-runtime-boundary.md` for the
full substrate contract.

**The constitutional rule (added in GM-24):** *approval is not
authorization; authorization is not execution.* The
`OUTCOMES.RECORDED` value names the act of recording a review
outcome — it is not a signal to act, and no production code in
GM-24 consumes recorded review decisions for any operational
purpose.

### 4c. The execution-authorization actor (GM-25) — eighth verification layer

The execution-authorization actor extends the chain with
actor-specific layers and a different layer-4 lock:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE` | Wrong intent type |
| 6 | `decision.decision === DECISION_OUTCOMES.ADMISSIBLE` | Outcome confusion (the classifier always returns admissible for this intent type) |
| 7 | `params.userRole === 'admin'` | Non-admin (rejected BEFORE any DB call) |
| 8 | `params.authorizationScope ∈ AUTHORIZATION_SCOPES`; `params.authorizationReason ∈ AUTHORIZATION_REASONS`; UUID validation on `pilotInstanceId` / `userId` / `reviewDecisionId` | Vocabulary + structural |

The **four DB-side data preconditions** (review_decision exists
in same pilot; review_outcome = 'approved'; authorizer ≠
reviewer; authorization_scope matches underlying intent type)
are NOT duplicated at the actor — they live in the
BEFORE-INSERT trigger on `governance_execution_authorizations`.
Same posture as GM-24's self-review trigger; the actor catches
early-failure cases, the trigger is the unforgeable wall.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All eight layers pass + DB trigger passes | One INSERT into `governance_execution_authorizations` via `withReviewContext` | `{outcome: 'authorized_recorded', decision, authorizationId, createdAt}` |
| Any actor-layer failure | THROW (before any DB call) | — |
| DB trigger raises | THROW (wrapped in `ReviewRepositoryError`) | — |

The substrate has **no consumer** in GM-25. The
`OUTCOMES.AUTHORIZED_RECORDED` value names the act of recording
an authorization — it is **not** a signal to act. Adversarial
test **G13** is a static-scan canary that asserts zero
references to `governance_execution_authorizations` outside the
documented writing path; it will fail the build if any future GM
accidentally introduces a consumer.

**The constitutional rule (extended at GM-25):** *approval is
not authorization; authorization is not execution; an
authorization row is NOT an execution signal.*

See `execution-authorization-runtime-boundary.md` for the full
substrate contract.

### 4d. The execution-claim-ledger actor (GM-26) — ten-layer chain + dual vocabulary locks

The execution-claim-ledger actor extends the chain with two new
actor-specific vocabulary locks and a different layer-4 intent
lock:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM` | Wrong intent type |
| 7 | `params.userRole === 'admin'` | Non-admin |
| 8 | `params.authorizationScope ∈ AUTHORIZATION_SCOPES` (GM-25 vocab) | Vocab |
| 9 | `params.executionSurface ∈ EXECUTION_SURFACES` (GM-26 vocab, all `future_*` prefixed) | Vocab |
| 10 | UUID validation on `pilotInstanceId` / `userId` / `executionAuthorizationId` | Structural |

The **five DB-side data preconditions** (authorization exists in
same pilot; scope equality; claimant ≠ authorizer; surface fits
scope per the 1:1 mapping; underlying review still approved) are
NOT duplicated at the actor — they live in the BEFORE-INSERT
trigger on `governance_execution_claims`.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All ten layers pass + DB trigger passes + UNIQUE not violated | One INSERT into `governance_execution_claims` via `withReviewContext` | `{outcome: 'claim_recorded', decision, claimId, createdAt}` |
| Any actor-layer failure | THROW (before any DB call) | — |
| DB trigger raises (incl. UNIQUE violation on replay) | THROW (wrapped in `ReviewRepositoryError`) | — |

The substrate has **no consumer** in GM-26. The
`OUTCOMES.CLAIM_RECORDED` value names the act of recording a
claim — it is **not** a signal to execute. Two adversarial
canaries enforce the inertness mechanically:

- **H22 — static-scan canary:** asserts zero references to
  `governance_execution_claims` outside the documented writing
  path. Fails the build if any future GM accidentally
  introduces a consumer.
- **H28 — file-scoped forbidden-vocabulary scan:** asserts
  the claim-ledger actor file contains none of `executed`,
  `completed`, `dispatched`, `delivered`, `finalized`,
  `succeeded`, `failed` as bare identifiers (per OQ-26.14).
  Mirrors the boundary-guard mechanical enforcement.

**The constitutional rule (extended at GM-26):** *approval is
not authorization; authorization is not execution; an
authorization row is NOT an execution signal; **a claim row is
NOT execution — it ONLY means "this authorization has now been
consumed exactly once."***

The actor filename includes "ledger" (per OQ-26.13) to make the
read-only / record-only nature visible at the file level. See
`execution-claim-runtime-boundary.md` for the full substrate
contract.

### 4e. The execution-attempt-ledger actor (GM-27) — ten-layer chain + dual vocabulary locks + the strictest forbidden-words list yet

The execution-attempt-ledger actor mirrors GM-26's structural
shape but with stricter operational-vocabulary discipline. The
actor file is mechanically forbidden by the boundary guard from
containing any of `executed`, `completed`, `dispatched`,
`delivered`, `finalized`, `succeeded`, `failed`, **`committed`**
as bare identifiers. The list is **stricter than GM-26 by one
word**: `committed` is added because it reads as outcome
semantics most strongly at this layer (the database-level commit
lives in the transaction layer, never in the actor file).

Verification chain:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT` | Wrong intent type |
| 7 | `params.userRole === 'admin'` | Non-admin |
| 8 | `params.authorizationScope ∈ AUTHORIZATION_SCOPES` (from GM-25) | Vocab |
| 9 | `params.executionSurface ∈ EXECUTION_SURFACES` (from GM-26, all `future_*`) | Vocab |
| 10 | UUID validation on `pilotInstanceId` / `userId` / `executionClaimId` | Structural |

The **five DB-side data preconditions** (claim exists in same
pilot; scope equality with claim; surface equality with claim;
attempter ≠ claimant; 5-deep chain walks to `review_outcome =
'approved'`) are NOT duplicated at the actor — they live in the
BEFORE-INSERT trigger.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All ten layers pass + DB trigger passes + UNIQUE not violated | One INSERT into `governance_execution_attempts` via `withReviewContext` | `{outcome: 'attempt_recorded', decision, attemptId, createdAt}` |
| Any actor-layer failure | THROW (before any DB call) | — |
| DB trigger or UNIQUE raises | THROW (wrapped in `ReviewRepositoryError`) | — |

The substrate has **no consumer** in GM-27. The
`OUTCOMES.ATTEMPT_RECORDED` value names the act of recording
that an attempt began — it does **not** mean anything happened
afterward. Three adversarial canaries enforce the inertness
mechanically:

- **I23 — static-scan canary**: asserts zero references to
  `governance_execution_attempts` outside the documented writing
  path.
- **I24 — file-scoped forbidden-vocabulary scan**: asserts the
  actor file contains none of the eight forbidden words above.
- **I27 — doc-presence canary**: asserts the boundary doc
  retains both "What this is NOT" and "What remains unresolved"
  sections (defends the next-outcome GM against silent removal
  of the phantom-attempt warning).

**The constitutional rule (extended at GM-27, now at five
levels):** *approval is not authorization; authorization is not
execution; an authorization row is NOT an execution signal; a
claim row is NOT execution — it only records single-consumption;
**an attempt row is NOT an outcome — it ONLY records the
beginning of an attempt.***

See `execution-attempt-runtime-boundary.md` for the full
substrate contract, including the eight-question "What remains
unresolved" enumeration that the future-outcome GM must
explicitly address.

### 4f. The execution-outcome-ledger actor (GM-28) — ten-layer chain + triple vocabulary locks + the strictest forbidden-words list in the substrate

The execution-outcome-ledger actor mirrors GM-27's structural
shape but with the strictest operational AND truth-claim
vocabulary discipline anywhere in the substrate. The actor file
is mechanically forbidden by the boundary guard from containing
any of GM-27's 8 outcome-implying words (`executed`,
`completed`, `dispatched`, `delivered`, `finalized`,
`succeeded`, `failed`, `committed`) PLUS 10 NEW truth-claim
words (`verified`, `confirmed`, `actual`, `actually`,
`definitely`, `proven`, `certain`, `real`, `reality`, `truth`)
as bare identifiers. The list is **18 words — strictest in the
substrate**.

Verification chain:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD` | Wrong intent type |
| 7 | `params.userRole === 'admin'` | Non-admin |
| 8 | `params.authorizationScope ∈ AUTHORIZATION_SCOPES` (from GM-25) | Vocab |
| 9 | `params.executionSurface ∈ EXECUTION_SURFACES` (from GM-26, all `future_*`) | Vocab |
| 10 | UUID validation on `pilotInstanceId` / `userId` / `executionAttemptId` | Structural |

Plus a vocabulary precondition: `params.outcomeType ∈
VALID_EXECUTION_OUTCOME_TYPES` (the 4-value `reported_*` set).
The actor rejects `reported_succeeded`, `reported_failed`,
`verified_completed`, the uppercase variants, and every other
smuggled value BEFORE opening a connection.

The **five DB-side data preconditions** (attempt exists in same
pilot; scope equality with attempt; surface equality with
attempt; recorder ≠ attempter; 6-deep chain walks to
`review_outcome = 'approved'`) are NOT duplicated at the actor
— they live in the BEFORE-INSERT trigger.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All ten layers + vocabulary precondition pass + DB trigger passes + UNIQUE not violated | One INSERT into `governance_execution_outcomes` via `withReviewContext` | `{outcome: 'outcome_recorded', decision, outcomeId, createdAt}` |
| Any actor-layer failure | THROW (before any DB call) | — |
| DB trigger, CHECK, or UNIQUE raises | THROW (wrapped in `ReviewRepositoryError`) | — |

The substrate has **no consumer** in GM-28. The
`OUTCOMES.OUTCOME_RECORDED` value names the act of recording a
human's observation — it does **not** mean anything happened,
was verified, was true, or had any actual effect. Four
adversarial canaries enforce the inertness mechanically:

- **J22 — static-scan canary**: asserts zero references to
  `governance_execution_outcomes` outside the documented
  writing path.
- **J24 — file-scoped forbidden-vocabulary scan**: asserts the
  actor file contains none of the 18 forbidden words above.
- **J27 — doc-presence canary**: asserts the boundary doc
  retains both "What this is NOT" and "What remains unresolved"
  sections (defends the future-verification GM against silent
  removal of the phantom-outcome warning).
- **J37 — `EXECUTION_OUTCOME_TYPES` snapshot**: exactly 4
  values, all `reported_*` prefixed. Adding `reported_succeeded`
  or `verified_completed` fails immediately.

**The constitutional rule (extended at GM-28, now at six
levels):** *approval is not authorization; authorization is not
execution; an authorization row is NOT an execution signal; a
claim row is NOT execution — it only records single-consumption;
an attempt row is NOT an outcome — it only records the beginning
of an attempt; **an outcome row is NOT truth — it only records
what a human reported observing.***

See `execution-outcome-runtime-boundary.md` for the full
substrate contract, including the ten-question "What remains
unresolved" enumeration that the future-verification GM must
explicitly address.

### 4g. The execution-verification-ledger actor (GM-29) — nine-layer chain + dual vocabulary locks + operational/repair forbidden-words list

The execution-verification-ledger actor mirrors GM-28's
structural shape but with operational AND fix-it vocabulary
discipline instead of truth-claim discipline. The actor file
is mechanically forbidden by the boundary guard from
containing any of TWENTY bare identifiers: 12 operational /
repair words (`executed`, `dispatched`, `retry`, `retried`,
`reconcile`, `reconciled`, `rollback`, `compensate`,
`side_effect`, `mutate`, `promote`, `admit`) plus 8 fix-it
temptation words (`fix`, `repair`, `correct`, `heal`,
`resolve`, `revert`, `undo`, `apply`). Bare `execute` and
`dispatch` are deliberately omitted because they would collide
with the actor contract method name `execute(decision, params)`;
past-tense forms (`executed` / `dispatched`) catch the
semantic temptation that matters.

Verification chain:

| # | Check | Catches |
|---|---|---|
| 4 | `decision.intentType === INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY` | Wrong intent type |
| 7 | `params.userRole === 'admin'` | Non-admin |
| 8 | `params.verificationType ∈ VERIFICATION_TYPES` (4-value channel vocab) | Vocab |
| 9 | `params.verificationResult ∈ VERIFICATION_RESULTS` (3-value vocab; `verified_*` isolated to this table) | Vocab |

Plus UUID validation on `pilotInstanceId` / `userId` /
`executionOutcomeId`. The actor rejects smuggled vocabulary
(`verified_succeeded`, `verified_failed`, `verified_completed`,
`reported_completed`, uppercase variants) BEFORE opening a
connection.

The **three DB-side data preconditions** (outcome exists in
same pilot; verifier ≠ recorder; 7-deep chain walks to
`review_outcome = 'approved'`) are NOT duplicated at the actor
— they live in the BEFORE-INSERT trigger.

Outcome routing:

| Conditions | Action | Outcome shape |
|---|---|---|
| All nine layers + vocabulary preconditions pass + DB trigger passes + UNIQUE not violated | One INSERT into `governance_execution_verifications` via `withReviewContext` | `{outcome: 'verification_recorded', decision, verificationId, createdAt}` |
| Any actor-layer failure | THROW (before any DB call) | — |
| DB trigger, CHECK, or UNIQUE raises | THROW (wrapped in `ReviewRepositoryError`) | — |

The substrate has **no consumer** in GM-29 (per constitutional
addendum 3). The `OUTCOMES.VERIFICATION_RECORDED` value names
the act of recording a verifier's check — it does **not** mean
anything is true, was repaired, was reconciled, or had any
operational effect. Four adversarial canaries enforce the
inertness mechanically:

- **K22 — static-scan canary**: asserts zero references to
  `governance_execution_verifications` outside the documented
  writing path. **Continuously enforced per constitutional
  addendum 3.**
- **K24 — file-scoped forbidden-vocabulary scan**: asserts the
  actor file contains none of the 20 forbidden words above.
- **K27 — doc-presence canary**: asserts the boundary doc
  retains all four required sections (`## What this is NOT`,
  `## What remains unresolved`, `## Verification is not
  reconciliation`, `## Verification does not execute or
  repair`) AND the verbatim phrase
  `verification ≠ reconciliation ≠ repair`.
- **K37 — vocabulary isolation**: asserts
  `VERIFICATION_TYPES` has exactly 4 values, `VERIFICATION_RESULTS`
  has exactly 3 values, and the `verified_*` prefix does NOT
  appear in `EXECUTION_OUTCOME_TYPES`.

**The constitutional rule (extended at GM-29, now at seven
levels):** *approval is not authorization; authorization is not
execution; an authorization row is NOT an execution signal; a
claim row is NOT execution — it only records single-consumption;
an attempt row is NOT an outcome — it only records the
beginning of an attempt; an outcome row is NOT truth — it only
records what a human reported observing; **a verification row
is NOT truth — it only records that a separate human
independently CHECKED the report and what they observed through
a named evidence channel.***

See `execution-verification-runtime-boundary.md` for the full
substrate contract, including the twelve-question "What remains
unresolved" enumeration that the future-conflict-resolution /
canonical-state GM must explicitly address.

## 5. The conversation runtime is unchanged

GM-22 does NOT modify `src/conversation/`. Direct callers of
`conversationRuntime.respond(...)` continue to work exactly as
they did after GM-20. The actor is a wrapper, not a gate;
mechanically, callers can still skip it.

The structural enforcement of "you cannot act without a
Decision" therefore lives at the **actor's** entry, not at the
runtime's entry. If the conversation runtime is ever mounted
from a production caller in a future GM, that GM will need to
decide whether to route through the actor or to wrap the runtime
in its own Decision gate. That is its own decision gate.

## 6. Forward-binding convention for future actors

When a future GM introduces a new actor (e.g. for
`memory.candidate.create`), it must satisfy:

1. **Accept a Decision as its first argument.** Use
   `instanceof Decision` + `isValidDecision` + frozen +
   intentType + structural revalidation, identical to GM-22's
   chain.
2. **Verify `decision.intentType` matches the actor's specific
   intent type.** Never accept a Decision for a different intent.
3. **Route by `decision.decision` to executed / abstained /
   rejected outcomes.** Use the same `OUTCOMES` enum.
4. **Never call the downstream capability before verification
   succeeds.** The downstream call must happen inside the
   admissible branch only.
5. **Emit operational logs only.** Persistent audit rows
   (`governance_audit_log`) are tied to data-mutation paths and
   the locked `EVENT_TYPES` vocabulary; adding a new audit event
   type is its own paired change to the GM-18 lock.
6. **Add a paired entry to the actors boundary guard** if the
   actor needs to import a new downstream layer (e.g.
   `../companion`, `../memory`). The current guard rejects those
   imports because the GM-22 actor does not need them.

## 7. Boundary guard

`scripts/ci/check-actors-boundary.js` scans `src/actors/` only
and fails the build on:

| Rule | Why |
|---|---|
| Any forbidden SQL keyword (`INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`TRUNCATE`/`GRANT`/`REVOKE`/`CREATE`/`SELECT`/`FROM`/`JOIN`/`WHERE`) | Actors are dispatchers, not data-access code. |
| The identifier `insertPrivateMemory` | Defense in depth — GM-22's actor does not write memory. |
| Import of `pg` | No direct DB access. |
| Import of any model SDK (`@anthropic-ai/sdk`, `openai`, `@openai/*`, etc.) | The conversation runtime owns the SDK boundary; the actor is one layer up. |
| Import of `http`/`https`/`express`/`fastify`/`koa`/`@hapi/hapi` | No HTTP. |
| Import of `child_process`/`worker_threads`/`cluster` (or their `node:` forms) | No subprocess, no worker thread. |
| Import of `../runtime`/`../db`/`../setup`/`../memory`/`../companion` (or subpaths) | Cross-layer reach is forbidden in GM-22 + GM-23 actors; future actors that need a particular layer will get a paired guard update. |
| Imports of `../governance/<deeper>`, `../conversation/<deeper>`, or `../review/<deeper>` | Only the public entries (`../governance`, `../governance/index`, `../conversation`, `../conversation/index`, `../review`, `../review/index`) are permitted. The `../review` entry was added in GM-23 (paired guard change with `check-actors-boundary.js`). |
| Scheduling identifiers (`setInterval`, `setImmediate`, `cron`, `schedule`) | No background work. `setTimeout` is permitted because it may appear transitively via the conversation runtime; GM-22's actor code does not call it directly. |
| Streaming / tool-calling identifiers (`.stream(`, `messages.stream`, `stream: true`, `tools`, `tool_choice`, `tool_use`, `tool_result`) | Defense in depth; the underlying conversation runtime already bans these. |
| `fs.writeFile*` / `appendFile*` / `createWriteStream` / `mkdir*` / `rm*` / `unlink*` | No filesystem writes. |

## 8. Adversarial review (the new gauntlet contribution)

`tests/governance/adversarial.test.js` is the project's first
**negative test surface**. Every assertion is "this must NOT
work". Per the GM-22 process lock, every high-risk GM going
forward must include or extend this suite with adversarial
probes against the contract it relies on.

The current suite covers:

- **A. GM-21 Decision opacity** — external constructor throws;
  `_createDecision`/`_TOKEN`/`_BLESSED` are not re-exported;
  mutation throws; classifier handles adversarial inputs
  (Proxies, frozen inputs, Symbol keys, `__proto__` payloads,
  injected-SQL-looking strings, oversized payloads) without
  throwing and without emitting to stdout.
- **B. GM-22 actor verification** — duck-typed objects rejected;
  prototype-tampered forgeries rejected by the WeakSet check;
  type-confusion (Decisions for the wrong intent type) rejected;
  non-object decision arguments rejected; classifier-produced
  Decisions are reusable (stateless actor); runtime errors
  surface cleanly without altering the Decision.
- **E. GM-23 review-queue actor verification** — duck-typed
  objects rejected; prototype-tampered forgeries rejected by the
  WeakSet check; admissible / inadmissible Decisions rejected by
  layer 6; cross-tenant impersonation rejected by RLS WITH CHECK
  in the integration suite; sentinel payload/evidence content
  never appears in actor or repository log lines (E1–E10).
- **C. EVENT_TYPES + REASONS + INTENT_TYPES snapshots** — the
  GM-18 audit vocabulary, the GM-21 REASONS vocabulary, and the
  GM-21 intent taxonomy are snapshot-locked. Any addition or
  removal fails this test, forcing a paired review of the
  governance docs.
- **D. The contract holds end-to-end** — no forgery the test
  suite can construct gets through; the classifier is the only
  production path to a Decision the actor accepts; mutation
  attempts (which fail at freeze-time) do not affect actor
  routing; and no side-channel writes to stdout when the
  classifier and the actor handle adversarial inputs.

Future high-risk GMs are expected to add scenarios specific to
the contract they introduce.

## 9. What must remain impossible — and what enforces it

| Property | Enforcement |
|---|---|
| Actor executes without a Decision | `execute(decision, ...)` requires the Decision argument; instanceof + WeakSet checks reject every non-classifier-produced input. |
| Actor accepts a forged Decision (prototype tampering) | `isValidDecision` (GM-22 WeakSet check) rejects every object not produced by `_createDecision`. Adversarial test B2 plants the exact forgery and asserts rejection. |
| Actor accepts a Decision for the wrong intent type | Intent-type confusion check (rule 4 above). Adversarial test B3. |
| Actor accepts a mutated Decision | Frozen check + the Decision constructor's own freeze. Adversarial test A5. |
| Actor executes on requires_review or inadmissible | Outcome routing branches; runtime not called. Tests assert `getCalls() === 0` on those paths. |
| Actor loops, retries, or schedules work | Stateless module; boundary guard bans `setInterval`/`setImmediate`/scheduling identifiers; single-call shape. |
| Actor writes to DB | Boundary guard bans `pg` and cross-layer imports of `../memory`/`../companion`. |
| Actor calls a model SDK | Boundary guard bans every model SDK by name. The actor calls `conversationRuntime.respond`, which is a method on an injected client; the actor never imports the SDK. |
| Actor introduces new audit `EVENT_TYPES` | None added in GM-22. Adversarial test C1 snapshots and asserts the lock holds. |
| Actor adds new endpoints / mounts to boot | Boundary guard bans HTTP frameworks. `src/runtime/boot.js` does not import `src/actors/`. |
| Actor logs response text / user message / memory content | Sentinel-scan unit test (`tests/actors/response-delivery-actor.test.js`) plants secrets in both the user message and the model response and asserts neither appears in any captured log line. The review-queue actor has its own sentinel scan (`tests/actors/review-queue-actor.test.js`) covering `payload_summary` and `evidence_summary`. |
| Review-queue actor stages a non-requires_review Decision | Layer 6 check (`decision.decision === REQUIRES_REVIEW`). Adversarial tests E2 / E3 plant admissible and inadmissible Decisions and assert rejection BEFORE any pool call. |
| Review-queue actor inserts under a forged tenant or impersonated proposer | The actor passes `proposer_user_id` from the session context, not from input. `withReviewContext` sets `app.user_id` via `set_config`, and the RLS `review_queue_insert_own` WITH CHECK enforces both tenant and proposer match. Adversarial E5 + integration suite plant the attack. |
| Review-queue actor mutates an existing queue row | No UPDATE / DELETE grants to `lylo_app`; the `governance_review_queue` BEFORE-UPDATE-OR-DELETE trigger raises on any attempt. Integration suite asserts. |

## 10. Enforcement summary

| Property | Enforced by |
|---|---|
| SQL / identifier / module-import bans | `check-actors-boundary.js` (CI) |
| Public-entry-only imports of `../governance` and `../conversation` | `check-actors-boundary.js` (CI) |
| Decision verification chain (5 layers including WeakSet) | `tests/actors/response-delivery-actor.test.js` (unit) + `tests/governance/adversarial.test.js` (negative) |
| Outcome routing per `decision.decision` | unit + adversarial |
| Runtime called exactly once on admissible, zero times on any other path | unit + adversarial |
| Sentinel privacy (user message + response + memory payload never appear in logs) | unit + adversarial |
| `EVENT_TYPES` / `REASONS` / `INTENT_TYPES` vocabulary locks | `tests/governance/adversarial.test.js` snapshots |

## 11. Change control

Adding a new actor, relaxing the boundary guard's import
allowlist, introducing a new actor-emitted operational event,
adding a new audit `EVENT_TYPES` entry, or mounting the actor
from boot is a boundary change. It requires a reviewed change
to this document **and** `check-actors-boundary.js` in the same
PR. When the change touches the GM-18 audit-vocabulary lock,
the same PR must update `src/memory/audit.js` `EVENT_TYPES`
AND the adversarial snapshot.

## Cross-references

- `governance-runtime-boundary.md` — the classifier and Decision
  shape this layer consumes.
- `conversation-runtime-boundary.md` — the downstream capability
  GM-22's response-delivery actor wraps.
- `review-queue-runtime-boundary.md` — the GM-23 substrate the
  review-queue actor stages into.
- `companion-runtime-boundary.md`, `memory-runtime-boundary.md`,
  `runtime-boundary.md` — orthogonal layers neither actor imports.
- `baseline-ci.md` — the CI guard set.
- `../../scripts/ci/check-actors-boundary.js` — the guard.
- `../../src/actors/` — the module.
- `../../tests/actors/response-delivery-actor.test.js` — the
  GM-22 positive contract tests.
- `../../tests/actors/review-queue-actor.test.js` — the GM-23
  positive contract tests.
- `../../tests/actors/execution-outcome-ledger-actor.test.js` —
  the GM-28 positive contract tests.
- `../../tests/governance/adversarial.test.js` — the negative
  contract tests (A–J series; J22/J24/J27/J37 lock GM-28).
