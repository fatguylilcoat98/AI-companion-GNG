'use strict';
/*
 * Actors public API — GM-22 + GM-23 + GM-24 + GM-25 + GM-26.
 *
 * Decision-gated executors. Every actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid + actor-
 *      specific outcome / role check).
 *   2. On admissible → execute (response-delivery actor) OR record
 *      a governance artifact (GM-23/24/25/26 actors).
 *   3. On requires_review → durably stage to the review queue
 *      (GM-23 review-queue actor).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw.
 *
 * Five actors today:
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
 *
 * Each actor has its own intent-type contract and its own outcome
 * routing. They share the OUTCOMES vocabulary (executed / abstained
 * / rejected / staged / recorded / authorized_recorded /
 * claim_recorded).
 */

const { createResponseDeliveryActor } = require('./response-delivery-actor');
const { createReviewQueueActor } = require('./review-queue-actor');
const { createReviewDecisionActor } = require('./review-decision-actor');
const { createExecutionAuthorizationActor } = require('./execution-authorization-actor');
const { createExecutionClaimLedgerActor } = require('./execution-claim-ledger-actor');
const { OUTCOMES } = require('./outcomes');

module.exports = {
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  OUTCOMES,
};
