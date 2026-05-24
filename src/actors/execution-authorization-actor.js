'use strict';
/*
 * Execution-authorization actor — GM-25.
 *
 * The fourth Decision-gated actor. Records an admin's explicit
 * authorization (against an approved review_decision) for eventual
 * execution, durably persisted into the new GM-25
 * governance_execution_authorizations append-only substrate.
 *
 * Constitutional invariant (added in GM-24, repeated here):
 *   Approval is NOT authorization.
 *   Authorization is NOT execution.
 *   An authorization row is NOT an execution signal.
 *
 * GM-25 records the authorization. No future actor in this module
 * reads recorded authorization rows to do anything operational.
 * Future execution capability is a separately-gated decision.
 *
 * The actor inherits the GM-22/GM-23/GM-24 verification chain
 * (instanceof Decision + isValidDecision WeakSet + frozen +
 * structural revalidation + intent-type + outcome lock) and adds
 * actor-specific layers:
 *
 *   7. params.userRole === 'admin'
 *   8. params.authorizationScope ∈ AUTHORIZATION_SCOPES
 *   9. params.authorizationReason ∈ AUTHORIZATION_REASONS
 *  10. UUID validation on pilotInstanceId, userId, reviewDecisionId
 *
 * The four DB-side data preconditions are enforced by the
 * BEFORE-INSERT trigger in db/migrations/010_execution_authorizations.sql:
 *   (a) review_decision exists in same pilot
 *   (b) review_outcome must = 'approved'
 *   (c) authorizer ≠ reviewer (self-authorization forbidden)
 *   (d) authorization_scope matches the underlying intent type
 *
 * Failure paths:
 *   - Forged / tampered / mutated Decision → THROW.
 *   - Decision with intentType !== governance.execution.authorize → THROW.
 *   - Decision outcome other than `admissible` → THROW.
 *   - userRole !== 'admin' → THROW BEFORE any DB call.
 *   - Vocabulary mismatch → THROW.
 *   - Verified valid admin execution_authorize Decision → INSERT one
 *     row into governance_execution_authorizations via
 *     withReviewContext → return {outcome: 'authorized_recorded',
 *     decision, authorizationId, createdAt}.
 *
 * What the actor does NOT do:
 *   - Execute the authorized action.
 *   - Read the authorization row after writing.
 *   - Mutate any prior governance artifact.
 *   - Perform any other DB op (no UPDATE, no DELETE, no SELECT
 *     beyond the implicit RETURNING).
 *   - Notify external systems.
 *   - Auto-promote, auto-action, auto-anything.
 *   - Schedule background work.
 */

const {
  Decision,
  isValidDecision,
  REASONS,
  DECISION_OUTCOMES,
  INTENT_TYPES,
} = require('../governance');
const { withReviewContext } = require('../review');
const { OUTCOMES } = require('./outcomes');

const VALID_REASONS = new Set(Object.values(REASONS));
const VALID_OUTCOMES = new Set(Object.values(DECISION_OUTCOMES));
const VALID_AUTHORIZATION_SCOPES = new Set([
  'memory_candidate_admission',
  'future_external_action',
  'future_visibility_change',
  'future_vault_action',
]);
const VALID_AUTHORIZATION_REASONS = new Set([
  'admin_explicit_authorization',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReviewQueuePool(handle) {
  // The review module exposes only the opaque ReviewPoolHandle.
  // Test mocks duck-type with a .connect function (which the
  // module's _resolvePool helper also accepts internally).
  return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'execution-authorization actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'execution-authorization actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('execution-authorization actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY governance.execution.authorize.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE) {
    throw new Error(
      `execution-authorization actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_OUTCOMES.has(decision.decision)) {
    throw new Error('execution-authorization actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('execution-authorization actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('execution-authorization actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible for
  // governance.execution.authorize. Defense in depth — refuse any
  // other outcome explicitly.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `execution-authorization actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('execution-authorization actor: params object is required');
  }
  const {
    pilotInstanceId,
    userId,
    userRole,
    reviewDecisionId,
    authorizationScope,
    authorizationReason,
  } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('execution-authorization actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('execution-authorization actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only. GM-25 admits no other
  // authorizer role. Widening requires a paired update to the
  // actor, the DB CHECK constraint, the RLS WITH CHECK, and the
  // docs.
  if (userRole !== 'admin') {
    throw new Error(
      `execution-authorization actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof reviewDecisionId !== 'string' || !UUID_RE.test(reviewDecisionId)) {
    throw new Error('execution-authorization actor: reviewDecisionId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `execution-authorization actor: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_AUTHORIZATION_REASONS.has(authorizationReason)) {
    throw new Error(
      `execution-authorization actor: authorizationReason must be one of ${Array.from(VALID_AUTHORIZATION_REASONS).join(', ')}`
    );
  }
}

function createExecutionAuthorizationActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createExecutionAuthorizationActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createExecutionAuthorizationActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
    );
  }
  const logger = log && typeof log.info === 'function' ? log : null;

  async function execute(decision, params) {
    // Verification first — throws on forged / tampered / wrong-role
    // / vocabulary-invalid input. The pool is not consulted on any
    // failure path.
    verifyDecisionOrThrow(decision);
    validateParams(params);

    const {
      pilotInstanceId,
      userId,
      userRole,
      reviewDecisionId,
      authorizationScope,
      authorizationReason,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordExecutionAuthorization({
          reviewDecisionId,
          authorizationScope,
          authorizationReason,
        })
    );

    if (logger) {
      // Metadata only — every field below is either a typed
      // identifier or a value from a locked vocabulary. No
      // free-text content is logged.
      logger.info('actor.execution_authorization.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        authorization_id: inserted.id,
        review_decision_id: reviewDecisionId,
        authorization_scope: authorizationScope,
        authorization_reason: authorizationReason,
        authorized_by_user_id: userId,
        authorized_by_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.AUTHORIZED_RECORDED,
      decision,
      authorizationId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createExecutionAuthorizationActor };
