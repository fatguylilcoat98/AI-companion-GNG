'use strict';
/*
 * Actors public API — GM-22 through GM-28.
 *
 * Decision-gated executors. Every actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid + actor-
 *      specific outcome / role check).
 *   2. On admissible → execute (response-delivery actor) OR record
 *      a governance artifact (GM-23/24/25/26/27/28 actors).
 *   3. On requires_review → durably stage to the review queue
 *      (GM-23 review-queue actor).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw.
 *
 * Seven actors today:
 *   - createResponseDeliveryActor (GM-22) — wraps the conversation
 *     runtime; admits ONLY decision.intentType === response.deliver.
 *   - createReviewQueueActor (GM-23) — stages requires_review
 *     Decisions into governance_review_queue.
 *   - createReviewDecisionActor (GM-24) — records a human admin's
 *     review outcome into governance_review_decisions. Admin only.
 *     Approval is NOT authorization.
 *   - createExecutionAuthorizationActor (GM-25) — records an
 *     admin's explicit authorization against an approved
 *     review_decision, into governance_execution_authorizations.
 *     Admin only; authorizer ≠ reviewer; scope ↔ intent.
 *     Authorization is NOT execution.
 *   - createExecutionClaimLedgerActor (GM-26) — records an
 *     admin's explicit claim of an authorization for a specific
 *     future execution surface, into governance_execution_claims.
 *     Admin only; claimant ≠ authorizer; surface ↔ scope;
 *     UNIQUE(authorization_id) enforces single-consumption. Claim
 *     is NOT execution; claim is NOT dispatch; claim is NOT
 *     completion; claim is NOT success.
 *   - createExecutionAttemptLedgerActor (GM-27) — records that an
 *     admin BEGAN an execution attempt against a claim. The first
 *     artifact in the chain that names "execution" — and
 *     deliberately stops short of saying whether anything
 *     actually happened. Admin only; attempter ≠ claimant; scope
 *     equality; surface equality; UNIQUE(claim_id) forbids retry.
 *     Constitutional rule: ATTEMPT IS NOT OUTCOME. An attempt row
 *     records ONLY the beginning of an attempt.
 *   - createExecutionOutcomeLedgerActor (GM-28) — records an
 *     admin's observation of an attempt's apparent state, into
 *     governance_execution_outcomes. Admin only; recorder ≠
 *     attempter (5th separation-of-duties stage); scope + surface
 *     equality with attempt; UNIQUE(attempt_id); outcome_type ∈
 *     the 4-value `reported_*` vocabulary (observational, not
 *     evaluative). Constitutional rule (strictest in the chain):
 *     AN OUTCOME ROW IS NOT TRUTH. `reported_completed` ≠
 *     `verified_completed`. Outcomes are OPTIONAL — missing rows
 *     are structurally valid.
 *
 * Each actor has its own intent-type contract and its own outcome
 * routing. They share the OUTCOMES vocabulary (executed / abstained
 * / rejected / staged / recorded / authorized_recorded /
 * claim_recorded / attempt_recorded / outcome_recorded).
 */

const { createResponseDeliveryActor } = require('./response-delivery-actor');
const { createReviewQueueActor } = require('./review-queue-actor');
const { createReviewDecisionActor } = require('./review-decision-actor');
const { createExecutionAuthorizationActor } = require('./execution-authorization-actor');
const { createExecutionClaimLedgerActor } = require('./execution-claim-ledger-actor');
const { createExecutionAttemptLedgerActor } = require('./execution-attempt-ledger-actor');
const { createExecutionOutcomeLedgerActor } = require('./execution-outcome-ledger-actor');
const { OUTCOMES } = require('./outcomes');

module.exports = {
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  createExecutionAttemptLedgerActor,
  createExecutionOutcomeLedgerActor,
  OUTCOMES,
};
