'use strict';
/*
 * Execution-claim ledger actor — GM-26.
 *
 * The fifth Decision-gated actor. Records an admin's explicit
 * claim of an execution authorization for a specific future
 * execution surface, durably persisted into the GM-26
 * governance_execution_claims append-only substrate.
 *
 * Constitutional invariant:
 *   Claim is NOT execution.
 *   Claim is NOT dispatch.
 *   Claim is NOT completion.
 *   Claim is NOT success.
 *   Claim ONLY means: "this authorization has now been consumed
 *   exactly once."
 *
 * Authorization without single-consumption semantics is
 * replayable authority. GM-26 makes replay prevention structural
 * BEFORE any execution surface exists.
 *
 * The actor name deliberately includes "ledger" to make the
 * read-only / record-only nature visible at the filename level.
 * This actor does NOT execute. It writes to an append-only
 * ledger. No production code in GM-26 consumes claim rows
 * operationally; adversarial test H22 is a static-scan canary
 * that enforces this.
 *
 * The actor inherits the GM-22/GM-23/GM-24/GM-25 verification
 * chain and adds actor-specific layers:
 *
 *   7.  params.userRole === 'admin'
 *   8.  params.authorizationScope ∈ AUTHORIZATION_SCOPES
 *   9.  params.executionSurface ∈ EXECUTION_SURFACES
 *   10. UUID validation on pilotInstanceId, userId,
 *       executionAuthorizationId
 *
 * The five DB-side data preconditions are enforced by the
 * BEFORE-INSERT trigger in db/migrations/011_execution_claims.sql:
 *   (a) authorization exists in same pilot
 *   (b) authorization_scope equality
 *   (c) claimant ≠ authorizer (self-claim forbidden)
 *   (d) execution_surface fits authorization_scope
 *   (e) underlying review_decision.review_outcome = 'approved'
 *
 * On the happy path the actor returns
 * {outcome: 'claim_recorded', decision, claimId, createdAt}.
 *
 * What the actor does NOT do (and what mechanical defenses
 * prevent it from doing):
 *
 *   - Execute the claimed action (no consumer of claim rows in
 *     src/; H22 static-scan canary asserts).
 *   - Dispatch anything (forbidden vocabulary in this file —
 *     H28 file-scoped scan asserts; see
 *     scripts/ci/check-review-boundary.js).
 *   - Read the claim row after writing.
 *   - Mutate any prior governance artifact.
 *   - Perform any other DB op (no UPDATE, no DELETE, no SELECT
 *     beyond the implicit RETURNING).
 *   - Notify external systems.
 *   - Schedule background work.
 *
 * Forbidden vocabulary in this file (enforced by
 * check-review-boundary.js file-scoped scan, per OQ-26.14):
 *   `xecuted`, `ompleted`, `ispatched`, `elivered`, `inalized`,
 *   `ucceeded`, `ailed` (used as bare identifiers).
 * (The fragments above are described intentionally without the
 * exact identifier — see the boundary guard for the regexes.)
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
const VALID_EXECUTION_SURFACES = new Set([
  'future_memory_admission_consumer',
  'future_external_action_consumer',
  'future_visibility_change_consumer',
  'future_vault_action_consumer',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReviewQueuePool(handle) {
  return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'execution-claim-ledger actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'execution-claim-ledger actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('execution-claim-ledger actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY governance.execution.claim.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM) {
    throw new Error(
      `execution-claim-ledger actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_OUTCOMES.has(decision.decision)) {
    throw new Error('execution-claim-ledger actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('execution-claim-ledger actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('execution-claim-ledger actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible for
  // governance.execution.claim. Defense in depth — refuse any
  // other outcome explicitly.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `execution-claim-ledger actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('execution-claim-ledger actor: params object is required');
  }
  const {
    pilotInstanceId,
    userId,
    userRole,
    executionAuthorizationId,
    authorizationScope,
    executionSurface,
  } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('execution-claim-ledger actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('execution-claim-ledger actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only.
  if (userRole !== 'admin') {
    throw new Error(
      `execution-claim-ledger actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof executionAuthorizationId !== 'string' || !UUID_RE.test(executionAuthorizationId)) {
    throw new Error('execution-claim-ledger actor: executionAuthorizationId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `execution-claim-ledger actor: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_EXECUTION_SURFACES.has(executionSurface)) {
    throw new Error(
      `execution-claim-ledger actor: executionSurface must be one of ${Array.from(VALID_EXECUTION_SURFACES).join(', ')}`
    );
  }
}

function createExecutionClaimLedgerActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createExecutionClaimLedgerActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createExecutionClaimLedgerActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
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
      executionAuthorizationId,
      authorizationScope,
      executionSurface,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordExecutionClaim({
          executionAuthorizationId,
          authorizationScope,
          executionSurface,
        })
    );

    if (logger) {
      // Metadata only — every field below is either a typed
      // identifier or a value from a locked vocabulary. No
      // free-text content.
      logger.info('actor.execution_claim.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        claim_id: inserted.id,
        execution_authorization_id: executionAuthorizationId,
        authorization_scope: authorizationScope,
        execution_surface: executionSurface,
        claimed_by_user_id: userId,
        claimed_by_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.CLAIM_RECORDED,
      decision,
      claimId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createExecutionClaimLedgerActor };
