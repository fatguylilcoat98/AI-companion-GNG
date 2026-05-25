# RLS / Privacy Contract

**Applies to:** the row-level-security policies on the real
`db/migrations/` schema. As of GM-15 they live in
`db/migrations/007_rls_policies.sql`; they are mechanically validated
in CI against both the synthetic schema (`run-contract.js`) and the
real migrations (`run-real.test.js`). RLS is **dormant in production**
until GM-16 wires the runtime / provisioning to connect via the
`lylo_*` roles — see "Runtime wire-up status" below.
**Status:** locked. Changes go through a reviewed change to this file,
`tests/rls-contract/policies.sql`, and `db/migrations/007_rls_policies.sql`
together.
**Depends on:** `source-of-truth-memory-policy.md` (the policy this
contract enforces), `runtime-boundary.md` (the runtime stays
read-only), `companion-config-contract.md` (the four config tables the
runtime reads).

## Purpose

The runtime configuration loader is read-only and touches only four
tables. The next phase — memory-governance extraction — will write and
read the memory tables, and the privacy guarantees in
`source-of-truth-memory-policy.md` must be enforced **at the database
level**, not only by application code. This document defines those
guarantees as a mechanical contract: a set of candidate RLS policies,
a session-variable convention, a DB-role model, and a CI-enforced
test matrix that exercises the access rules across roles, pilots,
visibility levels, and vault-session states.

As of GM-15, the contract is applied to the real schema by
`db/migrations/007_rls_policies.sql` and re-verified against the real
migrations on every PR by `tests/rls-contract/run-real.test.js`. The
synthetic suite (`run-contract.js`) remains: it is the contract's
machine-readable specification, useful for reviewing policy changes in
isolation from the application schema. Both suites run in the single
`rls-contract` CI job.

## Session-variable convention

The connecting application sets three session variables per request
(via `SET LOCAL app.* = '...'` inside a transaction):

| Variable | Meaning |
|---|---|
| `app.pilot_instance_id` | The user's pilot scope (UUID) |
| `app.user_id` | The connecting user (UUID) |
| `app.user_role` | Their role token: `senior` / `family` / `caregiver` / `admin` / `system` |

Policies read these with `current_setting('app.user_id', true)::uuid`.
When unset, `current_setting('…', true)` returns `NULL`; the equality
check yields `NULL` and the row is filtered out — default-deny.

## DB-role model

GM-15's `db/migrations/007_rls_policies.sql` creates the following
Postgres roles in the cluster. They are all `NOLOGIN`; GM-16 will
introduce the LOGIN role(s) the connecting application uses to acquire
them (decision OQ-15.5: separate LOGIN role + separate `DATABASE_URL`
per process — `LYLO_RUNTIME_DATABASE_URL`, `LYLO_SETUP_DATABASE_URL`).

| Role | Purpose | Table grants |
|---|---|---|
| `lylo_runtime` | Runtime configuration loader (GM-7b) | SELECT on `pilot_instances`, `companion_profile`, `supported_person_profile`, `setup_state`. **No grant on any of the seven governance-staging tables** (`governance_review_queue`, `governance_review_decisions`, `governance_execution_authorizations`, `governance_execution_claims`, `governance_execution_attempts`, `governance_execution_outcomes`, `governance_execution_verifications`). |
| `lylo_app` | Memory-governance runtime + all seven governance-staging actors (GM-23 through GM-29) | SELECT on all client-scoped tables; INSERT on `memory_store`, `governance_audit_log`, `memory_vault_sessions`, and the seven governance-staging tables (`governance_review_queue` GM-23, `governance_review_decisions` GM-24, `governance_execution_authorizations` GM-25, `governance_execution_claims` GM-26, `governance_execution_attempts` GM-27, `governance_execution_outcomes` GM-28, `governance_execution_verifications` GM-29); UPDATE (`revoked_at`) on `memory_vault_sessions`; all gated by RLS policies. **No UPDATE or DELETE on any of the seven governance-staging tables — append-only enforced by triggers plus GRANT absence.** |
| `lylo_setup` | Offline provisioning script (GM-12) | INSERT/SELECT on the four config tables + `users`; `BYPASSRLS` so it can seed. **No grant on any of the five governance-staging tables.** |
| `lylo_admin` | Operator | SELECT on most tables; **no** policy on `memory_store` or `memory_vaults`. **SELECT on all five governance-staging tables** — admins are the only role that can see authorization/claim/attempt rows in their pilot (GM-25/26/27: no proposer / reviewer / authorizer / claimant / attempter-as-non-admin / family / caregiver SELECT). |

Defense in depth: the table-level `GRANT` limits *which tables* a role
can address at all; RLS policies limit *which rows* within those
tables.

### Bootstrap policy for `lylo_runtime` on `pilot_instances`

Per OQ-15.2, the GM-15 migration installs a role-scoped policy
`pilot_instances_runtime_bootstrap ON pilot_instances FOR SELECT TO
lylo_runtime USING (true)`. This is intentional: GM-16's env-first
boot model sets `app.pilot_instance_id` before any query, so the
tenant-scope policy already permits the read; the bootstrap policy
fails closed only if env is misconfigured (the runtime sees all pilots
instead of zero). Safe under single-tenant — each runtime owns one
`DATABASE_URL` pointing at one pilot. `lylo_app` and `lylo_admin` are
NOT covered by the bootstrap policy and remain bound by the
tenant-scope rule on `pilot_instances`.

## Per-table policies

The runnable forms live in two places, byte-for-byte semantically
equivalent:

- `../../db/migrations/007_rls_policies.sql` — applied to the real
  schema.
- `../../tests/rls-contract/policies.sql` — applied to the synthetic
  schema by the contract suite.

The semantic summary:

### Tenant-scoped SELECT (every client-scoped table)

A row is visible only if `pilot_instance_id = current_setting('app.pilot_instance_id')::uuid`.
This is the single rule that produces **cross-pilot isolation**.

### `circle_contacts`

Visible to: the senior themselves; the contact themselves; admins in
the same pilot.

### `memory_vaults` and `memory_vault_sessions`

Visible to: the owning user **only**. Admin sees nothing. The PIN
hash and session state are private to the supported person.

### `memory_store`

Three permissive SELECT policies (OR'd):

1. **Owner** — the supported person sees all their own rows regardless
   of `visibility_level` or `admissibility_state`.
2. **`family_shared` circle** — visible iff:
   - `visibility_level = 'family_shared'`,
   - `admissibility_state = 'admissible'`,
   - a `circle_contacts` row links the owner to the connecting user
     **with `permission_scope.visibility_levels` containing
     `'family_shared'`**.
3. **`password_locked` session** — visible iff:
   - `visibility_level = 'password_locked'`,
   - `admissibility_state = 'admissible'`,
   - `vault_id IS NOT NULL`,
   - a `memory_vault_sessions` row exists for the connecting user with
     `expires_at > now()` and `revoked_at IS NULL` (the row-state
     vault model from OQ-14.3).

There is **no admin SELECT policy** on `memory_store` (OQ-14.2):
admins cannot see `private` or `password_locked` rows.

`INSERT` policy: the connecting user can only insert memories with
`owning_user_id = app.user_id` (no impersonation).

### `governance_review_queue` (GM-23)

Three SELECT policies (one INSERT policy):

1. **`review_queue_insert_own`** (INSERT WITH CHECK) — tenant
   match AND `proposer_user_id = current_setting('app.user_id')`.
   The connecting user can only stage rows for the pilot they
   declared and as the user they declared (no impersonation, no
   cross-pilot).
2. **`review_queue_proposer`** (SELECT) — tenant match AND
   `proposer_user_id = current_setting('app.user_id')`. A
   proposer can see only their own staged items.
3. **`review_queue_admin`** (SELECT) — tenant match AND
   `current_setting('app.user_role') = 'admin'`. Admins see all
   pending items in their pilot.

There is **no UPDATE policy** and **no DELETE policy** on
`governance_review_queue`. The table is append-only enforced
three ways: the BEFORE-UPDATE-OR-DELETE trigger raises, no
GRANTs allow UPDATE/DELETE to `lylo_app` (the only writing
role), and there is no RLS policy that would permit either op
even if a grant were added.

The `status` column has a locked CHECK (`status =
'pending_review'`). The DB cannot represent an "approved" or
"rejected" queue item — the substrate stages only. Status
transitions, dequeue, approval engines, and human-review tooling
are out of scope for GM-23.

### `governance_review_decisions` (GM-24)

Two SELECT policies + one INSERT policy:

1. **`review_decisions_insert_admin`** (INSERT WITH CHECK) —
   tenant match AND `reviewer_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`. Non-admin
   INSERT is rejected even with an otherwise-valid payload.
2. **`review_decisions_admin_select`** (SELECT) — tenant match
   AND `app.user_role = 'admin'`. Admins see all recorded review
   decisions in their pilot.
3. **`review_decisions_proposer_select`** (SELECT) — tenant
   match AND the row references a `governance_review_queue` row
   whose `proposer_user_id = app.user_id`. The original proposer
   of the underlying queue item learns the outcome of their
   staged item.

There is **no UPDATE policy** and **no DELETE policy** on
`governance_review_decisions`. The table is append-only enforced
three ways: the BEFORE-UPDATE-OR-DELETE trigger raises, no
GRANTs allow UPDATE/DELETE to `lylo_app` (the only writing
role), and there is no RLS policy that would permit either op
even if a grant were added.

A **BEFORE-INSERT** trigger looks up the referenced queue row's
`proposer_user_id` and raises `self-review forbidden` if it
equals the inserting `reviewer_user_id`. This closes the
self-approval gap at the DB layer; the actor performs the same
check for early failure but the trigger is the authoritative
wall.

`UNIQUE(review_queue_id)` enforces that each queue item is
reviewed at most once. The DB cannot represent two conflicting
decisions for the same queue item.

The `reviewer_role` column has a locked CHECK (`= 'admin'`); the
`review_outcome` column is CHECK-locked to `('approved',
'rejected')`; the `review_reason` column is CHECK-locked to a
5-value vocabulary. Each widening is its own decision gate.

**Constitutional rule:** recording a review outcome is **not**
authorization, and authorization is **not** execution. No
production code in GM-24 consumes `governance_review_decisions`
operationally. A future execution surface requires its own
decision gate, its own boundary guard, and its own adversarial
review.

### `governance_execution_authorizations` (GM-25)

Two policies — admin-only INSERT and admin-only SELECT.

1. **`auth_insert_admin`** (INSERT WITH CHECK) — tenant match
   AND `authorized_by_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`.
2. **`auth_admin_select`** (SELECT) — tenant match AND
   `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer-as-non-admin / family /
caregiver SELECT policy.** Authorizations are admin-to-admin
governance metadata.

There is **no UPDATE policy** and **no DELETE policy**. The
table is append-only enforced three ways: the
BEFORE-UPDATE-OR-DELETE trigger raises, no GRANTs allow
UPDATE/DELETE to `lylo_app`, and no RLS policy would permit
either op even if a grant were added.

A **BEFORE-INSERT preconditions trigger** walks the chain
authorization → review_decision → review_queue and raises if
any of four data preconditions fail:
- the referenced review_decision must exist in the same pilot,
- `review_outcome` must be `'approved'` (cannot authorize a
  rejected review),
- `authorized_by_user_id` ≠ `reviewer_user_id` (self-authorization
  forbidden),
- `authorization_scope` must match the queue's
  `decision_intent_type` via the hardcoded mapping documented in
  `execution-authorization-runtime-boundary.md` §2.

`UNIQUE(review_decision_id)` enforces that each approved review
is authorized at most once. The DB cannot represent two
conflicting authorizations for the same review.

The `authorized_by_role` column has a locked CHECK (`= 'admin'`);
`authorization_scope` is CHECK-locked to a 4-value vocabulary;
`authorization_reason` is CHECK-locked to a 1-value vocabulary.
Each widening is its own decision gate.

**Constitutional rule:** recording an authorization is **not**
execution. An authorization row is **not** an execution signal.
No production code in GM-25 consumes
`governance_execution_authorizations` operationally. Adversarial
test G13 is a static-scan canary that asserts zero references to
the table outside the documented writing path.

### `governance_execution_claims` (GM-26)

Two policies — admin-only INSERT and admin-only SELECT.

1. **`claim_insert_admin`** (INSERT WITH CHECK) — tenant match
   AND `claimed_by_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`.
2. **`claim_admin_select`** (SELECT) — tenant match AND
   `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant-as-non-admin /
family / caregiver SELECT policy.** Claims are admin-only
governance metadata.

There is **no UPDATE policy** and **no DELETE policy**. The
table is append-only enforced three ways: the
BEFORE-UPDATE-OR-DELETE trigger raises, no GRANTs allow
UPDATE/DELETE to `lylo_app`, and no RLS policy would permit
either op even if a grant were added.

A **BEFORE-INSERT preconditions trigger** walks the chain claim
→ authorization → review_decision and raises if any of five
data preconditions fail:
- the referenced authorization must exist in the same pilot,
- `authorization_scope` on the claim must equal the
  authorization's scope (drift detection),
- `authorized_by_user_id` ≠ `claimed_by_user_id` (self-claim
  forbidden),
- `execution_surface` must fit `authorization_scope` per the
  hardcoded 1:1 mapping (see
  `execution-claim-runtime-boundary.md` §2),
- the underlying `review_decision.review_outcome` must still be
  `'approved'` (defense in depth — impossible-by-design today
  since review_decisions are append-only).

`UNIQUE(execution_authorization_id)` is the **replay-prevention
wall**: each authorization is claimable at most once. The DB
cannot represent multiple claims against the same authorization.

The `claimed_by_role` column has a locked CHECK (`= 'admin'`);
`authorization_scope` is CHECK-locked to GM-25's 4-value
vocabulary; `execution_surface` is CHECK-locked to a NEW
4-value GM-26 vocabulary with mandatory `future_*` prefix. Each
widening is its own decision gate.

**Constitutional rule:** *claim is NOT execution; claim is NOT
dispatch; claim is NOT completion; claim is NOT success.* A
claim row ONLY means "this authorization has now been consumed
exactly once." No production code in GM-26 consumes
`governance_execution_claims` operationally. Adversarial test
**H22** is a static-scan canary that asserts zero references to
the table outside the documented writing path. **H27** asserts
the `future_*` prefix discipline on EXECUTION_SURFACES. **H28**
asserts the actor file contains no operational vocabulary.

### `governance_execution_attempts` (GM-27)

Two policies — admin-only INSERT and admin-only SELECT.

1. **`attempt_insert_admin`** (INSERT WITH CHECK) — tenant
   match AND `attempted_by_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`.
2. **`attempt_admin_select`** (SELECT) — tenant match AND
   `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant /
attempter-as-non-admin / family / caregiver SELECT policy.**
Attempts are admin-only governance metadata.

**No UPDATE / DELETE policy.** Append-only at every layer.

A **BEFORE-INSERT preconditions trigger** walks the 5-deep chain
attempt → claim → authorization → review_decision and raises if
any of five data preconditions fail:
- the referenced claim must exist in the same pilot,
- `authorization_scope` on the attempt must equal the claim's
  scope (drift detection),
- `execution_surface` on the attempt must equal the claim's
  surface (drift detection),
- `claimed_by_user_id` ≠ `attempted_by_user_id` (self-attempt
  forbidden),
- the underlying `review_decision.review_outcome` must still be
  `'approved'` (defense in depth).

`UNIQUE(execution_claim_id)` forbids retry / multi-attempt
semantics. The DB cannot represent multiple attempts against
the same claim.

The `attempted_by_role` column has a locked CHECK (`= 'admin'`);
`authorization_scope` inherits GM-25's 4-value vocab;
`execution_surface` inherits GM-26's 4-value vocab.

**Constitutional rule:** *ATTEMPT IS NOT OUTCOME.* An attempt
row records ONLY the beginning of an attempt — never success,
failure, completion, interruption, delivery, dispatch,
finalization, or commit state. No production code in GM-27
consumes `governance_execution_attempts` operationally.
Adversarial test **I23** is a static-scan canary; **I24** is a
file-scoped forbidden-vocabulary scan on the actor file
(stricter than GM-26 H28 — adds `committed`); **I27** is a
doc-presence canary asserting the boundary doc retains both
"What this is NOT" and "What remains unresolved" sections.

### `governance_execution_outcomes` (GM-28)

Two policies — admin-only INSERT and admin-only SELECT.

1. **`outcome_insert_admin`** (INSERT WITH CHECK) — tenant
   match AND `recorded_by_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`.
2. **`outcome_admin_select`** (SELECT) — tenant match AND
   `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant / attempter /
recorder-as-non-admin / family / caregiver SELECT policy.**
Outcomes are admin-only governance metadata.

**No UPDATE / DELETE policy.** Append-only at every layer.

A **BEFORE-INSERT preconditions trigger** walks the 6-deep chain
outcome → attempt → claim → authorization → review_decision and
raises if any of five data preconditions fail:
- the referenced attempt must exist in the same pilot,
- `authorization_scope` on the outcome must equal the attempt's
  scope (drift detection / retroactive-rewrite prevention),
- `execution_surface` on the outcome must equal the attempt's
  surface (drift detection / retroactive-rewrite prevention),
- `attempted_by_user_id` ≠ `recorded_by_user_id` (self-recording
  forbidden),
- the underlying `review_decision.review_outcome` must still be
  `'approved'` (defense in depth).

`UNIQUE(execution_attempt_id)` forbids replay. The DB cannot
represent multiple outcomes against the same attempt. Outcomes
are also OPTIONAL — an attempt may exist forever with no
outcome row.

The `recorded_by_role` column has a locked CHECK (`= 'admin'`);
`authorization_scope` inherits GM-25's 4-value vocab;
`execution_surface` inherits GM-26's 4-value vocab.
`outcome_type` is **locked at the DB layer** via CHECK to
exactly four `reported_*` observational values:
`reported_completed`, `reported_interrupted`,
`reported_abandoned`, `reported_unknown`. The `reported_*`
prefix is a constitutional boundary, not a naming style.

**Constitutional rule:** *AN OUTCOME ROW IS NOT TRUTH.*
`reported_completed` ≠ `verified_completed`. An outcome row
records ONLY what a human reported observing — never a
verification, never a truth claim, never a success/failure
verdict. No production code in GM-28 consumes
`governance_execution_outcomes` operationally. Adversarial test
**J22** is a static-scan canary; **J24** is a file-scoped
forbidden-vocabulary scan on the actor file (STRICTEST in the
substrate — 18 words: GM-27's 8 outcome-implying words plus 10
truth-claim words); **J27** is a doc-presence canary asserting
the boundary doc retains both "What this is NOT" and "What
remains unresolved" sections; **J37** is a snapshot canary
asserting `EXECUTION_OUTCOME_TYPES` contains exactly the 4
`reported_*` values.

### `governance_execution_verifications` (GM-29)

Two policies — admin-only INSERT and admin-only SELECT.

1. **`verification_insert_admin`** (INSERT WITH CHECK) — tenant
   match AND `verified_by_user_id = current_setting('app.user_id')`
   AND `current_setting('app.user_role') = 'admin'`.
2. **`verification_admin_select`** (SELECT) — tenant match AND
   `app.user_role = 'admin'`.

**No proposer / reviewer / authorizer / claimant / attempter /
recorder / verifier-as-non-admin / family / caregiver SELECT
policy.** Verifications are admin-only governance metadata.

**No UPDATE / DELETE policy.** Append-only at every layer.

A **BEFORE-INSERT preconditions trigger** walks the 7-deep chain
verification → outcome → attempt → claim → authorization →
review_decision and raises if any of three data preconditions
fail:
- the referenced outcome must exist in the same pilot,
- `recorded_by_user_id` ≠ `verified_by_user_id` (self-
  verification forbidden — extends adjacent-only separation-
  of-duties chain to 6 deep),
- the underlying `review_decision.review_outcome` must still
  be `'approved'` (defense in depth).

`UNIQUE(execution_outcome_id)` forbids replay. The DB cannot
represent multiple verifications against the same outcome.
Verifications are also OPTIONAL — an outcome may exist forever
with no verification row, and absence is NOT itself a
verification result.

The `verified_by_role` column has a locked CHECK
(`= 'admin'`). `verification_type` is **CHECK-locked at the DB
layer** to exactly four channel values: `human_observation`,
`system_log_review`, `database_state_check`,
`external_confirmation`. `verification_result` is
**CHECK-locked at the DB layer** to exactly three result
values: `verified_consistent`, `verified_inconsistent`,
`verification_inconclusive`. The `verified_*` prefix is a
constitutional boundary, isolated to this table.

No `verification_basis` column. GM-29 stores governance
metadata only — no evidence payloads.

**Constitutional rule:** *VERIFICATION ≠ RECONCILIATION ≠
REPAIR.* `verified_consistent` ≠ truth.
`verification_inconclusive` ≠ retry / escalate / "someone must
act." A verification row is epistemic, not authoritative. No
production code in GM-29 consumes
`governance_execution_verifications` operationally. Adversarial
test **K22** is a static-scan canary (continuously enforced per
constitutional addendum 3); **K24** is a file-scoped
forbidden-vocabulary scan on the actor file (20 words: 12
operational/repair + 8 fix-it temptation); **K27** is a doc-
presence canary asserting all four required sections AND the
verbatim phrase `verification ≠ reconciliation ≠ repair`;
**K37** is a snapshot canary asserting `VERIFICATION_TYPES`
contains exactly 4 values, `VERIFICATION_RESULTS` exactly 3,
and the `verified_*` prefix does NOT appear in
`EXECUTION_OUTCOME_TYPES`.

### `governance_audit_log`

- Admins see all in-pilot events (SELECT).
- A user sees events where they are the `target_user_id` (SELECT).
- `INSERT` requires `actor_user_id = app.user_id` (no impersonation).
- The real schema's append-only trigger remains the authority on
  UPDATE/DELETE rejection.

## Cross-pilot isolation rule

Every policy in this contract is `pilot_instance_id`-scoped. There is
**no** policy that exposes a row whose `pilot_instance_id` does not
match `current_setting('app.pilot_instance_id')::uuid`. Cross-pilot
reads are mechanically impossible under any role / context.

## Default-deny rule

When RLS is `ENABLE`d on a table and no policy permits the row, the
row is invisible. The contract enables RLS on every client-scoped
table; therefore **any table the connecting application can address
but has no matching policy returns zero rows**.

If a future PR adds a new table to `db/migrations/` without adding a
policy in this contract, the runtime cannot read it. That is
intentional: new tables must be paired with new contract entries.

## Vault-session row-state model (OQ-14.3)

The `password_locked` visibility policy is **row-state-based**: a
`memory_vault_sessions` row whose `expires_at` has passed, or whose
`revoked_at` is non-null, does **not** unlock memories. There is no
session-variable shortcut; the application cannot fake a vault session
by setting a flag. The vault is unlocked iff the row exists in the
correct state.

## What the contract enforces and what it does not

The contract enforces:

- Tenant isolation (cross-pilot reads impossible).
- The `memory_store` visibility matrix above.
- Vault content / session privacy.
- Admin denial on private memory.
- Default-deny when policies are missing or session variables unset.
- INSERT-impersonation prevention via `WITH CHECK`.

The contract does **not** model:

- Memory immutability (real schema's BEFORE-UPDATE trigger).
- Audit append-only (real schema's BEFORE-UPDATE-OR-DELETE trigger).
- Application-level admissibility lifecycle, retraction, supersession
  workflow — these are policy concerns from
  `source-of-truth-memory-policy.md` enforced at the application
  layer.
- Authentication or the service-login role that the application uses
  to acquire `lylo_app`.

## CI enforcement

The `rls-contract` baseline-CI job runs the matrix on every PR against
both the synthetic schema (`run-contract.js`) and the real
migrations (`run-real.test.js`). It is no longer a scaffold; a failure
in either suite fails the build. See `baseline-ci.md`.

## Runtime wire-up status

| Step | Status | PR |
|---|---|---|
| Synthetic contract validates policies | Landed | GM-14 |
| Real-schema migration installs roles, GRANTs, RLS, policies | Landed | GM-15 |
| Real-schema contract suite runs on every PR | Landed | GM-15 |
| Runtime connects as `lylo_runtime` via `LYLO_RUNTIME_DATABASE_URL` | Landed | GM-16 |
| Loader sets `app.pilot_instance_id` via env-first `LYLO_PILOT_INSTANCE_ID` (OQ-15.2) | Landed | GM-16 |
| Provisioning connects as `lylo_setup` via `LYLO_SETUP_DATABASE_URL` | Landed | GM-16 |
| `rls-engagement` integration test proves RLS is engaged (not silently bypassed) | Landed | GM-16 |
| Memory-governance module connects as `lylo_app` via `LYLO_APP_DATABASE_URL`; `withMemoryContext` binds `app.pilot_instance_id` / `app.user_id` / `app.user_role` per transaction; audit-bundled read + insert-private surface; dedicated `check-memory-boundary.js` guard; integration matrix proves cross-pilot isolation, family/admin/vault visibility rules, default-deny, audit rollback, cross-user impersonation blocked, and `lylo_app_login` carries no `BYPASSRLS` | Landed | GM-17 |
| Review-queue substrate: `db/migrations/008_review_queue.sql` adds `governance_review_queue` with CHECK constraints mirroring GM-21 INTENT_TYPES + REASONS, locked `status = 'pending_review'`, BEFORE-UPDATE-OR-DELETE trigger, and the three RLS policies above. `src/review/` library + `src/actors/review-queue-actor.js` connect via the existing `LYLO_APP_DATABASE_URL` (no new env). `withReviewContext` binds the same three session vars. Integration matrix proves cross-pilot isolation, impersonation rejection, proposer/admin/family/caregiver visibility, append-only trigger, runtime/setup role denial | Landed | GM-23 |
| Review-decision substrate: `db/migrations/009_review_decisions.sql` adds `governance_review_decisions` (admin-only INSERT WITH CHECK, admin + proposer SELECT, append-only trigger, self-review BEFORE-INSERT trigger, UNIQUE on review_queue_id). `src/review/` extends with three new ctx operations (listPending / inspect / record); `src/actors/review-decision-actor.js` is the third Decision-gated actor (seven-layer verification chain, admin-only role). Reuses `LYLO_APP_DATABASE_URL` (no new env). Integration matrix proves admin records / proposer reads outcome / family-caregiver-denied / self-review-rejected / double-review-rejected / cross-pilot-rejected / append-only-enforced / lylo_runtime-grant-denied. No production consumer — recording is NOT execution; approval is NOT authorization | Landed | GM-24 |
| Execution-authorization substrate: `db/migrations/010_execution_authorizations.sql` adds `governance_execution_authorizations` (admin-only INSERT WITH CHECK, admin-only SELECT, append-only trigger, preconditions BEFORE-INSERT trigger walking the full chain to enforce review-approved + non-self-authorization + scope-↔-intent matching, UNIQUE on review_decision_id). `src/review/` extends with three new ctx operations (recordExecutionAuthorization / listExecutionAuthorizations / inspectExecutionAuthorization); `src/actors/execution-authorization-actor.js` is the fourth Decision-gated actor (eight-layer verification chain, admin-only role, vocabulary locks). Reuses `LYLO_APP_DATABASE_URL` (no new env). Integration matrix proves admin authorizes / proposer-denied / non-admin-denied / self-authorization-rejected / rejected-review-rejected / scope-mismatch-rejected / double-authorization-rejected / cross-pilot-rejected / append-only-enforced / lylo_runtime-grant-denied. **No production consumer.** Adversarial G13 is a static-scan canary that mechanically refuses any consumer reference outside the documented writing path. Authorization is NOT execution; an authorization row is NOT an execution signal | Landed | GM-25 |
| Execution-claim substrate: `db/migrations/011_execution_claims.sql` adds `governance_execution_claims` (admin-only INSERT WITH CHECK, admin-only SELECT, append-only trigger, BEFORE-INSERT preconditions trigger walking authorization → review_decision and enforcing scope equality + non-self-claim + surface ↔ scope 1:1 mapping + chain-walk to review_outcome = 'approved', UNIQUE on execution_authorization_id as the replay-prevention wall). `src/review/` extends with three new ctx operations (recordExecutionClaim / listExecutionClaims / inspectExecutionClaim); `src/actors/execution-claim-ledger-actor.js` is the fifth Decision-gated actor (ten-layer verification chain, admin-only role, dual vocabulary locks AUTHORIZATION_SCOPES + EXECUTION_SURFACES). Reuses `LYLO_APP_DATABASE_URL`. Fixture adds admin3-A/admin3-B (per OQ-26.15) so claimant ≠ authorizer naturally (admin authorizes; admin3 claims). Integration matrix proves admin3 claims / proposer-denied / family-denied / self-claim-trigger-raises / replay-UNIQUE-raises / scope-drift-trigger-raises / surface-mismatch-trigger-raises / cross-pilot-FK-rejection / append-only-enforced / lylo_runtime-grant-denied. **No production consumer.** Adversarial H22 = static-scan canary enforces zero references outside writing path; H27 = future_* prefix discipline on EXECUTION_SURFACES; H28 = file-scoped forbidden-vocabulary scan on the ledger actor. Claim is NOT execution; claim is NOT dispatch; claim is NOT completion; claim is NOT success — claim ONLY means "this authorization has now been consumed exactly once" | Landed | GM-26 |
| Execution-attempt substrate: `db/migrations/012_execution_attempts.sql` adds `governance_execution_attempts` (admin-only INSERT WITH CHECK, admin-only SELECT, append-only trigger, BEFORE-INSERT preconditions trigger walking claim → authorization → review_decision and enforcing scope equality with claim + surface equality with claim + non-self-attempt + 5-deep chain-walk to review_outcome = 'approved', UNIQUE on execution_claim_id forbidding retry / multi-attempt). `src/review/` extends with three new ctx operations (recordExecutionAttempt / listExecutionAttempts / inspectExecutionAttempt); `src/actors/execution-attempt-ledger-actor.js` is the sixth Decision-gated actor (ten-layer verification chain). Reuses `LYLO_APP_DATABASE_URL`. Fixture adds admin4-A/admin4-B (per OQ-27.15) so attempter ≠ claimant naturally (admin3 claims; admin4 attempts). Integration matrix proves admin4 attempts / proposer-denied / family-denied / self-attempt-trigger-raises / replay-UNIQUE-raises / scope-drift-trigger-raises / surface-drift-trigger-raises / cross-pilot-FK-rejection / append-only-enforced / lylo_runtime-grant-denied. **No production consumer.** Three adversarial canaries: I23 = static-scan zero-references-outside-writing-path; I24 = file-scoped forbidden-vocabulary scan on the ledger actor (STRICTER than H28 — adds `committed`); I27 = doc-presence canary asserting both "What this is NOT" and "What remains unresolved" sections remain in the boundary doc. **ATTEMPT IS NOT OUTCOME** — records ONLY the beginning of an attempt; never success, failure, completion, interruption, delivery, dispatch, finalization, or commit state | Landed | GM-27 |
| Execution-outcome substrate: `db/migrations/013_execution_outcomes.sql` adds `governance_execution_outcomes` (admin-only INSERT WITH CHECK, admin-only SELECT, append-only trigger, BEFORE-INSERT preconditions trigger walking attempt → claim → authorization → review_decision and enforcing scope equality with attempt + surface equality with attempt + non-self-recording + 6-deep chain-walk to review_outcome = 'approved', UNIQUE on execution_attempt_id forbidding replay, CHECK on outcome_type locking the 4-value `reported_*` observational vocabulary at the DB layer). `src/review/` extends with three new ctx operations (recordExecutionOutcome / listExecutionOutcomes / inspectExecutionOutcome); `src/actors/execution-outcome-ledger-actor.js` is the seventh Decision-gated actor (ten-layer verification chain + vocabulary precondition). Reuses `LYLO_APP_DATABASE_URL`. Fixture adds admin5-A/admin5-B (per OQ-28.15) so recorder ≠ attempter naturally (admin4 attempts; admin5 records). Integration matrix proves admin5 records all four `reported_*` values / proposer-denied / self-recording-trigger-raises / replay-UNIQUE-raises / scope-drift-trigger-raises / surface-drift-trigger-raises / cross-pilot-FK-rejection / append-only-enforced / lylo_runtime-grant-denied / DB-CHECK-rejects-non-reported_*-vocabulary. **No production consumer.** Outcomes are OPTIONAL — absence of an outcome row is NOT itself an outcome. Four adversarial canaries: J22 = static-scan zero-references-outside-writing-path; J24 = file-scoped forbidden-vocabulary scan on the ledger actor (STRICTEST in the substrate — 18 words: GM-27's 8 outcome-implying words plus 10 truth-claim words `verified` / `confirmed` / `actual` / `actually` / `definitely` / `proven` / `certain` / `real` / `reality` / `truth`); J27 = doc-presence canary asserting both "What this is NOT" and "What remains unresolved" sections remain in the boundary doc; J37 = `EXECUTION_OUTCOME_TYPES` snapshot asserting exactly 4 values all `reported_*` prefixed. **AN OUTCOME ROW IS NOT TRUTH** — `reported_completed` ≠ `verified_completed`; the `reported_*` prefix puts the report-vs-verdict distinction into the data itself | Landed | GM-28 |
| Execution-verification substrate: `db/migrations/014_execution_verifications.sql` adds `governance_execution_verifications` (admin-only INSERT WITH CHECK, admin-only SELECT, append-only trigger, BEFORE-INSERT preconditions trigger walking outcome → attempt → claim → authorization → review_decision and enforcing non-self-verification + 7-deep chain-walk to review_outcome = 'approved', UNIQUE on execution_outcome_id forbidding replay, CHECK on verification_type locking the 4-value channel vocabulary + CHECK on verification_result locking the 3-value vocabulary at the DB layer). NO `verification_basis` column (per OQ-29.3(d) + constitutional addendum 7 — GM-29 stores governance metadata only). `src/review/` extends with three new ctx operations (recordExecutionVerification / listExecutionVerifications / inspectExecutionVerification); `src/actors/execution-verification-ledger-actor.js` is the eighth Decision-gated actor (nine-layer verification chain + two vocabulary preconditions). Reuses `LYLO_APP_DATABASE_URL`. Fixture adds admin6-A/admin6-B (per OQ-29.15) so verifier ≠ recorder naturally (admin5 records outcomes; admin6 verifies them). Integration matrix proves admin6 records every `verified_*` / `verification_inconclusive` combination / proposer-denied / self-verification-trigger-raises / replay-UNIQUE-raises / missing-outcome-rejected / cross-pilot-FK-rejection / append-only-enforced / lylo_runtime-grant-denied / DB-CHECK-rejects-smuggled-verified-vocabulary. **No production consumer (continuously enforced per constitutional addendum 3).** Verifications are OPTIONAL — absence of a verification row is NOT itself a verification result. Four adversarial canaries: K22 = static-scan zero-references-outside-writing-path; K24 = file-scoped forbidden-vocabulary scan on the ledger actor (20 words: 12 operational/repair `executed`/`dispatched`/`retry`/`retried`/`reconcile`/`reconciled`/`rollback`/`compensate`/`side_effect`/`mutate`/`promote`/`admit` + 8 fix-it temptation `fix`/`repair`/`correct`/`heal`/`resolve`/`revert`/`undo`/`apply`); K27 = doc-presence canary asserting all four required sections (`What this is NOT`, `What remains unresolved`, `Verification is not reconciliation`, `Verification does not execute or repair`) AND the verbatim phrase `verification ≠ reconciliation ≠ repair`; K37 = `VERIFICATION_TYPES` (4) + `VERIFICATION_RESULTS` (3) snapshot + `verified_*` isolation from `EXECUTION_OUTCOME_TYPES`. **VERIFICATION ≠ RECONCILIATION ≠ REPAIR** — `verified_consistent` ≠ truth; `verification_inconclusive` ≠ retry / escalate / "someone must act"; the `verified_*` prefix is constitutionally isolated to this table | Landed | GM-29 |

As of GM-16 the connection wire-up is complete:

- `src/runtime/env.js` requires `LYLO_RUNTIME_DATABASE_URL` and
  `LYLO_PILOT_INSTANCE_ID` (UUID-validated). The historical
  `DATABASE_URL` / `PILOT_INSTANCE_ID` / `RLS_ENFORCED` variables are
  no longer accepted (OQ-16.2, OQ-16.7).
- `src/runtime/config-loader.js` binds the pilot id inside every
  loader transaction with
  `SELECT set_config('app.pilot_instance_id', $1, true)` (parameter-
  safe; equivalent to `SET LOCAL`). Tenant-scope RLS narrows every
  subsequent SELECT. A presence check confirms the env-supplied pilot
  exists before the four config reads run.
- `scripts/setup/provision-instance.js` reads `LYLO_SETUP_DATABASE_URL`.
  `lylo_setup` has `BYPASSRLS` for seeding; the script has no grants
  on any memory table so a stray write would fail at the GRANT layer.
- `tests/integration/rls-engagement.test.js` proves the runtime's
  LOGIN role is denied on memory tables, that tenant-scope narrows
  reads even though the bootstrap policy permits all
  `pilot_instances` SELECTs, and that misconfigured provisioning
  (running the script as `lylo_runtime`) fails closed.

Operators provision the LOGIN roles once per cluster — see
`../deployment/operator-runbook.md` §8 "LOGIN role provisioning". Note
that `BYPASSRLS` is a Postgres role attribute that does not inherit
through role membership; the setup LOGIN role must carry it directly,
the runtime LOGIN role must not.

## Change control

Locked. Any change to a policy or to the DB-role model is a reviewed
change to **this document**, **`tests/rls-contract/policies.sql`**,
and **`db/migrations/007_rls_policies.sql`** together in the same PR.
Adding a new table to `db/migrations/` requires adding a corresponding
policy here, in the synthetic `policies.sql`, and in `007` (or a
follow-on numbered migration) in the same PR.

## Cross-references

- `source-of-truth-memory-policy.md` — the privacy policy the contract
  enforces (§11 default-private, §12 family_shared rules, §13
  password_locked rules, §14 audit requirements).
- `runtime-boundary.md` — the runtime stays read-only against four
  tables.
- `companion-config-contract.md` — the four config tables.
- `baseline-ci.md` — the `rls-contract` job.
- `../../tests/rls-contract/policies.sql` — the synthetic-schema form.
- `../../tests/rls-contract/run-real.test.js` — the real-schema proof.
- `../../db/migrations/007_rls_policies.sql` — the real-schema
  application.
