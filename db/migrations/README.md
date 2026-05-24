# Database migrations

Migrations for the Lylo Companion platform live here, one file per
migration, numbered sequentially (`NNN_short_description.sql`).

## Status (GM-26)

Migrations `001`–`011` are in place: the GM-3 baseline schema,
the GM-15 RLS / privacy policies, the GM-23 review-queue
substrate, the GM-24 review-decision substrate, the GM-25
execution-authorization substrate, and the GM-26 execution-claim
substrate. The master starts a **clean** migration chain — no
historical or archived SQL is carried over from any reference
system.

| Migration | Establishes |
|---|---|
| `001_baseline.sql` | `pilot_instances` (tenancy root), `users`, one-senior-per-pilot. |
| `002_profiles.sql` | `companion_profile`, `supported_person_profile`, `circle_contacts`. |
| `003_vaults.sql` | `memory_vaults`, `memory_vault_sessions`. |
| `004_memory_store.sql` | `memory_store` with provenance / visibility / admissibility columns + an immutability trigger. |
| `005_audit_log.sql` | `governance_audit_log` + an append-only trigger. |
| `006_setup_state.sql` | `setup_state`. |
| `007_rls_policies.sql` | The four `lylo_*` DB roles, schema USAGE + per-table GRANTs, `ENABLE ROW LEVEL SECURITY` on the ten client-scoped tables, and the validated RLS policies. See `docs/governance/rls-privacy-contract.md`. RLS is engaged in production as of GM-16. |
| `008_review_queue.sql` | `governance_review_queue` — the GM-23 durable substrate for `requires_review` Decisions. CHECK constraints mirror GM-21 INTENT_TYPES + REASONS; `status` is locked to `'pending_review'`; a BEFORE-UPDATE-OR-DELETE trigger enforces append-only; three RLS policies (insert_own / proposer SELECT / admin SELECT) gate access; INSERT grants only to `lylo_app`, SELECT to `lylo_app` and `lylo_admin`, no grants to `lylo_runtime` or `lylo_setup`. See `docs/governance/review-queue-runtime-boundary.md`. |
| `009_review_decisions.sql` | `governance_review_decisions` — the GM-24 durable substrate for the human admin's review outcome (`approved` / `rejected`) against a pending queue item. Also adds a `UNIQUE (pilot_instance_id, id)` constraint to `governance_review_queue` so the new composite FK can point at it. `reviewer_role` CHECK-locked to `'admin'`; `review_outcome` CHECK in `('approved','rejected')`; `review_reason` CHECK in a 5-value vocabulary; `UNIQUE(review_queue_id)` enforces one review per queue item; BEFORE-UPDATE-OR-DELETE trigger enforces append-only; BEFORE-INSERT trigger refuses if reviewer is the original proposer (self-review prevention); three RLS policies (insert_admin / admin SELECT / proposer SELECT). Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`, none to `lylo_runtime`/`lylo_setup`. **Recording a review is NOT execution. Approval is NOT authorization.** See `docs/governance/review-decision-runtime-boundary.md`. |
| `010_execution_authorizations.sql` | `governance_execution_authorizations` — the GM-25 durable substrate for an admin's explicit execution authorization against an approved review_decision. `authorized_by_role` CHECK-locked to `'admin'`; `authorization_scope` CHECK in a 4-value vocabulary (`memory_candidate_admission`, `future_external_action`, `future_visibility_change`, `future_vault_action`); `authorization_reason` CHECK in 1-value vocabulary (`admin_explicit_authorization`); `UNIQUE(review_decision_id)` enforces one authorization per review (replay prevention); BEFORE-UPDATE-OR-DELETE trigger enforces append-only; **BEFORE-INSERT preconditions trigger** walks the chain and refuses if the review was not approved, if the authorizer is the same human who reviewed, or if the scope doesn't match the underlying queue item's intent type. Two RLS policies (admin-only INSERT WITH CHECK + admin-only SELECT — no proposer/reviewer/family/caregiver visibility). Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`, none to `lylo_runtime`/`lylo_setup`. **An authorization row is NOT an execution signal.** No production code in GM-25 consumes this table. See `docs/governance/execution-authorization-runtime-boundary.md`. |
| `011_execution_claims.sql` | `governance_execution_claims` — the GM-26 durable substrate for an admin's explicit single-consumption claim of an authorization for a specific future execution surface. `claimed_by_role` CHECK-locked to `'admin'`; `authorization_scope` mirrors GM-25's 4-value vocabulary; `execution_surface` CHECK in a NEW 4-value vocabulary with mandatory `future_*` prefix (`future_memory_admission_consumer`, `future_external_action_consumer`, `future_visibility_change_consumer`, `future_vault_action_consumer`); `UNIQUE(execution_authorization_id)` is the **replay-prevention wall** — each authorization may be claimed at most once; BEFORE-UPDATE-OR-DELETE trigger enforces append-only; **BEFORE-INSERT preconditions trigger** walks the chain and refuses if the authorization doesn't exist, if the claim's scope differs from the authorization's, if the claimant is the same human who authorized, if the execution_surface doesn't fit the scope (1:1 mapping), or if the underlying review is no longer approved. Two RLS policies (admin-only INSERT WITH CHECK + admin-only SELECT). Grants: SELECT+INSERT to `lylo_app`, SELECT to `lylo_admin`, none to `lylo_runtime`/`lylo_setup`. **A claim row is NOT execution; it ONLY means "this authorization has now been consumed exactly once."** No production code in GM-26 consumes this table; H22 static-scan canary mechanically enforces. See `docs/governance/execution-claim-runtime-boundary.md`. |

### Deferred — not in GM-26

- **Admissibility lifecycle.** GM-3 ships the `admissibility_state`
  column and the `superseded_by` link only; the proposed/pending/verified
  flow, dispute handling, and the authority-validation workflow
  remain deferred.
- **Execution consumer.** GM-26 introduces single-consumption
  semantics via `UNIQUE(execution_authorization_id)` on
  `governance_execution_claims` — but a recorded claim is **not**
  execution. Future execution capabilities would need a
  separately gated decision, a separately gated boundary guard,
  a separately gated adversarial review, and explicit semantics
  for revocation, expiry, partial-consumption, and rollback
  (none of which exist in GM-26).
- **Claim revocation / expiry.** GM-26 ships the artifact only —
  claims are append-only and have no `revoked_at` or
  `valid_until`. Future GMs may introduce these in paired
  changes.
- **Consumer of `governance_execution_authorizations` /
  `governance_review_decisions` / `governance_execution_claims`.**
  No production code reads any of the three operational-staging
  tables for any operational purpose. The G13 + H22 adversarial
  static-scan canaries assert zero references outside the
  documented writing path for each substrate.
- **Authorization revocation / expiry.** GM-25 ships the artifact
  only — authorizations are append-only.
- Derived-memory, outbound-message, and compose-authorization
  tables.

## Rules

- One file per migration, numbered `NNN_*.sql`.
- Additive-first; destructive changes require explicit owner sign-off
  recorded in the migration header.
- Each migration opens with a `-- Plan:` comment and ends with its
  rollback SQL, commented, after the body.
- The master ships schema only — never client data. A copied instance
  runs these migrations against its own empty database.
