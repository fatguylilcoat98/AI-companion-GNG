'use strict';
/*
 * Execution-attempt ledger actor — GM-27.
 *
 * The sixth Decision-gated actor. Records that an admin (different
 * from the claimant) BEGAN an execution attempt against a claim,
 * durably persisted into the GM-27 governance_execution_attempts
 * append-only substrate.
 *
 * CONSTITUTIONAL INVARIANT (strictest in the chain so far):
 *
 *   ATTEMPT IS NOT OUTCOME.
 *
 * This file is mechanically forbidden by the boundary guard's
 * file-scoped scan (scripts/ci/check-review-boundary.js, per
 * OQ-27.14) from containing any of the following as bare
 * identifiers:
 *
 *   ^c^o^m^p^l^e^t^e^d, ^s^u^c^c^e^e^d^e^d, ^f^a^i^l^e^d,
 *   ^d^e^l^i^v^e^r^e^d, ^f^i^n^a^l^i^z^e^d, ^e^x^e^c^u^t^e^d,
 *   ^d^i^s^p^a^t^c^h^e^d, ^c^o^m^m^i^t^t^e^d
 *
 * (The fragments above are written intentionally without the bare
 * identifier — see the boundary guard for the exact regex set.)
 *
 * The "ledger" in the filename is mandatory per OQ-27.13. It
 * makes the read-only / record-only nature visible at the file
 * level. This actor does NOT do the thing in its name; it writes
 * to an append-only ledger.
 *
 * The actor inherits the GM-22/GM-23/GM-24/GM-25/GM-26 verification
 * chain and adds actor-specific layers:
 *
 *   7.  params.userRole === 'admin'
 *   8.  params.authorizationScope ∈ AUTHORIZATION_SCOPES (from GM-25)
 *   9.  params.executionSurface ∈ EXECUTION_SURFACES (from GM-26)
 *   10. UUID validation on pilotInstanceId, userId,
 *       executionClaimId
 *
 * The five DB-side data preconditions are enforced by the
 * BEFORE-INSERT trigger in
 * db/migrations/012_execution_attempts.sql:
 *   (a) claim exists in same pilot
 *   (b) authorization_scope equals the claim's scope
 *   (c) execution_surface equals the claim's surface
 *   (d) attempter ≠ claimant (self-attempt forbidden)
 *   (e) chain attempt → claim → authorization → review_decision
 *       resolves to review_outcome = 'approved'
 *
 * On the happy path the actor returns
 * {outcome: 'attempt_recorded', decision, attemptId, createdAt}.
 *
 * What the actor does NOT do (and what mechanical defenses
 * prevent it from doing):
 *
 *   - Run the thing the attempt is "for" (no consumer of attempt
 *     rows in src/; I23 static-scan canary asserts).
 *   - Record outcome / success / failure / interruption /
 *     verification (operational vocabulary forbidden in this file
 *     — I24 file-scoped scan asserts; see boundary guard).
 *   - Read the attempt row after writing.
 *   - Mutate any prior governance artifact.
 *   - Perform any other DB op (no UPDATE, no DELETE, no SELECT
 *     beyond the implicit RETURNING).
 *   - Notify external systems.
 *   - Schedule background work.
 *
 * Phantom attempts are an unresolved question: an attempt row may
 * exist forever without any outcome row, because GM-27 ships no
 * outcome semantics. See
 * docs/governance/execution-attempt-runtime-boundary.md
 * "What remains unresolved" for the enumeration the future-outcome
 * GM must address.
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
const VALID_OUTCOMES_SET = new Set(Object.values(DECISION_OUTCOMES));
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
      'execution-attempt-ledger actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'execution-attempt-ledger actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('execution-attempt-ledger actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY
  // governance.execution.attempt.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT) {
    throw new Error(
      `execution-attempt-ledger actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_OUTCOMES_SET.has(decision.decision)) {
    throw new Error('execution-attempt-ledger actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('execution-attempt-ledger actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('execution-attempt-ledger actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible
  // for governance.execution.attempt. Defense in depth — refuse
  // any other outcome explicitly.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `execution-attempt-ledger actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('execution-attempt-ledger actor: params object is required');
  }
  const {
    pilotInstanceId,
    userId,
    userRole,
    executionClaimId,
    authorizationScope,
    executionSurface,
  } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('execution-attempt-ledger actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('execution-attempt-ledger actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only.
  if (userRole !== 'admin') {
    throw new Error(
      `execution-attempt-ledger actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof executionClaimId !== 'string' || !UUID_RE.test(executionClaimId)) {
    throw new Error('execution-attempt-ledger actor: executionClaimId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `execution-attempt-ledger actor: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_EXECUTION_SURFACES.has(executionSurface)) {
    throw new Error(
      `execution-attempt-ledger actor: executionSurface must be one of ${Array.from(VALID_EXECUTION_SURFACES).join(', ')}`
    );
  }
}

function createExecutionAttemptLedgerActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createExecutionAttemptLedgerActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createExecutionAttemptLedgerActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
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
      executionClaimId,
      authorizationScope,
      executionSurface,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordExecutionAttempt({
          executionClaimId,
          authorizationScope,
          executionSurface,
        })
    );

    if (logger) {
      // Metadata only — every field below is either a typed
      // identifier or a value from a locked vocabulary. No
      // free-text content.
      logger.info('actor.execution_attempt.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        attempt_id: inserted.id,
        execution_claim_id: executionClaimId,
        authorization_scope: authorizationScope,
        execution_surface: executionSurface,
        attempted_by_user_id: userId,
        attempted_by_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.ATTEMPT_RECORDED,
      decision,
      attemptId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createExecutionAttemptLedgerActor };
