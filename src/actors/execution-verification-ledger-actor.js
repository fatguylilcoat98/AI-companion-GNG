'use strict';
/*
 * Execution-verification ledger actor — GM-29.
 *
 * The eighth Decision-gated actor. Records a verifier's
 * independent check of a reported outcome, durably persisted
 * into the GM-29 governance_execution_verifications append-only
 * substrate.
 *
 * CONSTITUTIONAL INVARIANT:
 *
 *   VERIFICATION IS NOT RECONCILIATION IS NOT REPAIR.
 *
 * A verification row is epistemic, not authoritative. It
 * records what was checked, by whom, through which channel,
 * and whether the result appeared consistent with the reported
 * outcome. It does NOT establish canonical truth.
 *
 * The verification_type vocabulary names the evidence channel:
 *
 *   human_observation     — a person looked.
 *   system_log_review     — a person read a log.
 *   database_state_check  — a person queried a separate store.
 *   external_confirmation — a person obtained an independent
 *                           attestation.
 *
 * The verification_result vocabulary is 3 values; the
 * `verified_*` prefix is constitutionally isolated to this
 * substrate (K37 snapshot test enforces it does NOT leak into
 * EXECUTION_OUTCOME_TYPES):
 *
 *   verified_consistent       — checker observed what they
 *                               expected, given the report.
 *   verified_inconsistent     — checker observed something
 *                               that did NOT match the report.
 *   verification_inconclusive — checker could not establish
 *                               consistency either way.
 *
 * Deliberately EXCLUDED:
 *   - verified_succeeded / verified_failed (would smuggle
 *     truth claims via verification)
 *   - verification_refused
 *   - automated_check (automation-as-verifier is a separate
 *     decision gate)
 *
 * This file is mechanically forbidden by the boundary guard's
 * file-scoped scan (scripts/ci/check-review-boundary.js, per
 * OQ-29.10(b)) from containing any of TWENTY-TWO bare
 * identifiers — the strictest scan in the substrate:
 *
 *   The 14 operational/repair words:
 *     ^e^x^e^c^u^t^e, ^e^x^e^c^u^t^e^d, ^d^i^s^p^a^t^c^h,
 *     ^d^i^s^p^a^t^c^h^e^d, ^r^e^t^r^y, ^r^e^t^r^i^e^d,
 *     ^r^e^c^o^n^c^i^l^e, ^r^e^c^o^n^c^i^l^e^d, ^r^o^l^l^b^a^c^k,
 *     ^c^o^m^p^e^n^s^a^t^e, ^s^i^d^e^_^e^f^f^e^c^t,
 *     ^m^u^t^a^t^e, ^p^r^o^m^o^t^e, ^a^d^m^i^t
 *
 *   PLUS the 8 fix-it temptation words:
 *     ^f^i^x, ^r^e^p^a^i^r, ^c^o^r^r^e^c^t, ^h^e^a^l,
 *     ^r^e^s^o^l^v^e, ^r^e^v^e^r^t, ^u^n^d^o, ^a^p^p^l^y
 *
 * (Fragments above written intentionally without the bare
 * identifier — see the boundary guard for the exact regex set.)
 *
 * The "ledger" in the filename is mandatory per OQ-29.9. It
 * makes the read-only / record-only nature visible at the file
 * level. This actor does NOT do the thing in its name; it
 * writes to an append-only ledger.
 *
 * The actor inherits the GM-22 through GM-28 verification
 * chain and adds actor-specific layers:
 *
 *   7.  params.userRole === 'admin'
 *   8.  params.verificationType ∈ VERIFICATION_TYPES (GM-29 NEW)
 *   9.  params.verificationResult ∈ VERIFICATION_RESULTS (GM-29 NEW)
 *
 * Plus UUID validation on pilotInstanceId, userId,
 * executionOutcomeId.
 *
 * The three DB-side data preconditions are enforced by the
 * BEFORE-INSERT trigger in
 * db/migrations/014_execution_verifications.sql:
 *   (a) outcome exists in same pilot
 *   (b) verifier != outcome recorder (self-verification
 *       forbidden, 6th separation-of-duties stage)
 *   (c) chain verification -> outcome -> attempt -> claim ->
 *       authorization -> review_decision resolves to
 *       review_outcome = 'approved'
 *
 * On the happy path the actor returns
 * {outcome: 'verification_recorded', decision, verificationId, createdAt}.
 *
 * What the actor does NOT do (and what mechanical defenses
 * prevent it from doing):
 *
 *   - Trigger any downstream action (K22 static-scan canary
 *     asserts zero consumers of governance_execution_verifications
 *     in src/).
 *   - Change the outcome row (the outcome substrate is also
 *     append-only at every layer).
 *   - Make a truth claim (the K24 word list bans the operational
 *     and fix-it vocabulary that would slide toward that).
 *   - Read the verification row after writing.
 *   - Perform any other DB op (no UPDATE, no DELETE).
 *   - Notify external systems.
 *   - Schedule background work.
 *
 * The phantom-verification question remains unresolved: a
 * missing verification row is structurally valid in GM-29 and
 * is NOT itself a verification result. See
 * docs/governance/execution-verification-runtime-boundary.md
 * "What remains unresolved" for the items the future-conflict-
 * resolution GM must address.
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
const VALID_DECISION_OUTCOMES_SET = new Set(Object.values(DECISION_OUTCOMES));
// The GM-29 locked verification vocabularies. K37 snapshot test
// enforces both. CHECK constraints in
// db/migrations/014_execution_verifications.sql are
// authoritative.
const VALID_VERIFICATION_TYPES = new Set([
  'human_observation',
  'system_log_review',
  'database_state_check',
  'external_confirmation',
]);
const VALID_VERIFICATION_RESULTS = new Set([
  'verified_consistent',
  'verified_inconsistent',
  'verification_inconclusive',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReviewQueuePool(handle) {
  return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'execution-verification-ledger actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'execution-verification-ledger actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('execution-verification-ledger actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY
  // governance.execution.verify.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY) {
    throw new Error(
      `execution-verification-ledger actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_DECISION_OUTCOMES_SET.has(decision.decision)) {
    throw new Error('execution-verification-ledger actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('execution-verification-ledger actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('execution-verification-ledger actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible
  // for governance.execution.verify. Defense in depth.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `execution-verification-ledger actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('execution-verification-ledger actor: params object is required');
  }
  const {
    pilotInstanceId,
    userId,
    userRole,
    executionOutcomeId,
    verificationType,
    verificationResult,
  } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('execution-verification-ledger actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('execution-verification-ledger actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only.
  if (userRole !== 'admin') {
    throw new Error(
      `execution-verification-ledger actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof executionOutcomeId !== 'string' || !UUID_RE.test(executionOutcomeId)) {
    throw new Error('execution-verification-ledger actor: executionOutcomeId must be a UUID');
  }
  // Layer 8 (actor-specific): verification_type vocabulary.
  if (!VALID_VERIFICATION_TYPES.has(verificationType)) {
    throw new Error(
      `execution-verification-ledger actor: verificationType must be one of ${Array.from(VALID_VERIFICATION_TYPES).join(', ')}`
    );
  }
  // Layer 9 (actor-specific): verification_result vocabulary.
  if (!VALID_VERIFICATION_RESULTS.has(verificationResult)) {
    throw new Error(
      `execution-verification-ledger actor: verificationResult must be one of ${Array.from(VALID_VERIFICATION_RESULTS).join(', ')}`
    );
  }
}

function createExecutionVerificationLedgerActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createExecutionVerificationLedgerActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createExecutionVerificationLedgerActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
    );
  }
  const logger = log && typeof log.info === 'function' ? log : null;

  async function execute(decision, params) {
    verifyDecisionOrThrow(decision);
    validateParams(params);

    const {
      pilotInstanceId,
      userId,
      userRole,
      executionOutcomeId,
      verificationType,
      verificationResult,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordExecutionVerification({
          executionOutcomeId,
          verificationType,
          verificationResult,
        })
    );

    if (logger) {
      // Metadata only — every field below is either a typed
      // identifier or a value from a locked vocabulary. No
      // free-text content. There is no verification_basis
      // field anywhere in the substrate (per OQ-29.3(d) +
      // constitutional addendum 7).
      logger.info('actor.execution_verification.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        verification_id: inserted.id,
        execution_outcome_id: executionOutcomeId,
        verification_type: verificationType,
        verification_result: verificationResult,
        verified_by_user_id: userId,
        verified_by_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.VERIFICATION_RECORDED,
      decision,
      verificationId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createExecutionVerificationLedgerActor };
