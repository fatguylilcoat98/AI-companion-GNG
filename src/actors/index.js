'use strict';
/*
 * Actors public API — GM-22 + GM-23 + GM-24 + GM-25.
 *
 * Decision-gated executors. Every actor's contract:
 *   1. Accept a Decision (instanceof + WeakSet-blessed + frozen +
 *      intent-type-correct + structural-vocabulary-valid + actor-
 *      specific outcome / role check).
 *   2. On admissible → execute (response-delivery actor) OR record
 *      a governance artifact (GM-23/24/25 actors).
 *   3. On requires_review → durably stage to the review queue
 *      (GM-23 review-queue actor).
 *   4. On inadmissible → return rejected outcome (no execution).
 *   5. On forged/tampered/mismatched Decision → throw (programmer
 *      error).
 *
 * Four actors today:
 *   - createResponseDeliveryActor (GM-22) — wraps the conversation
 *     runtime; admits ONLY decision.intentType === response.deliver.
 *   - createReviewQueueActor (GM-23) — stages requires_review
 *     Decisions into governance_review_queue; admits ANY intent
 *     type as long as decision.decision === requires_review.
 *   - createReviewDecisionActor (GM-24) — records a human admin's
 *     review outcome ('approved' | 'rejected') against a pending
 *     queue item, into governance_review_decisions; admits ONLY
 *     decision.intentType === governance.review.decide AND
 *     params.userRole === 'admin'. Approval is NOT authorization.
 *   - createExecutionAuthorizationActor (GM-25) — records an
 *     admin's explicit authorization against an approved
 *     review_decision, into governance_execution_authorizations;
 *     admits ONLY decision.intentType === governance.execution.authorize
 *     AND params.userRole === 'admin'. DB-level preconditions:
 *     review must be approved, authorizer ≠ reviewer, scope must
 *     match the underlying intent type. Authorization is NOT
 *     execution; an authorization row is NOT an execution signal.
 *
 * Each actor has its own intent-type contract and its own outcome
 * routing. They share the OUTCOMES vocabulary (executed / abstained
 * / rejected / staged / recorded / authorized_recorded).
 */

const { createResponseDeliveryActor } = require('./response-delivery-actor');
const { createReviewQueueActor } = require('./review-queue-actor');
const { createReviewDecisionActor } = require('./review-decision-actor');
const { createExecutionAuthorizationActor } = require('./execution-authorization-actor');
const { OUTCOMES } = require('./outcomes');

module.exports = {
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  OUTCOMES,
};
