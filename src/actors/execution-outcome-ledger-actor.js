'use strict';
/*
 * Execution-outcome ledger actor — GM-28.
 *
 * The seventh Decision-gated actor. Records an admin's observation
 * of an attempt's apparent state, durably persisted into the
 * GM-28 governance_execution_outcomes append-only substrate.
 *
 * CONSTITUTIONAL INVARIANT (the strictest in the entire chain):
 *
 *   AN OUTCOME ROW IS NOT TRUTH.
 *
 * The `reported_*` prefix on every outcome_type value is the
 * constitutional defense. It puts "this is what someone said
 * happened, not what actually happened" into the data itself.
 *
 * The 4 outcome_type values are observational, not evaluative:
 *
 *   reported_completed   — recorder believes the attempt finished
 *                          its work. Does NOT mean "it succeeded"
 *                          or "the side effect occurred."
 *   reported_interrupted — recorder believes the attempt was
 *                          stopped externally. Does NOT mean
 *                          "it failed" or "an error occurred."
 *   reported_abandoned   — recorder gave up on the attempt.
 *                          Does NOT mean "the attempt was wrong."
 *   reported_unknown     — recorder has no information. Active
 *                          epistemic uncertainty, NOT a default
 *                          filler state.
 *
 * Deliberately EXCLUDED:
 *   - reported_succeeded / reported_failed (would smuggle truth
 *     claims under the prefix)
 *   - reported_partial (creates a sliding scale; the 4
 *     observational states are crisper)
 *   - reported_verified (verification is a SEPARATE future ring
 *     with its own non-`reported_*` vocabulary)
 *
 * This file is mechanically forbidden by the boundary guard's
 * file-scoped scan (scripts/ci/check-review-boundary.js, per
 * OQ-28.14) from containing any of EIGHTEEN bare identifiers:
 *
 *   The GM-27 list (8 outcome-implying words):
 *     ^c^o^m^p^l^e^t^e^d, ^s^u^c^c^e^e^d^e^d, ^f^a^i^l^e^d,
 *     ^d^e^l^i^v^e^r^e^d, ^f^i^n^a^l^i^z^e^d, ^e^x^e^c^u^t^e^d,
 *     ^d^i^s^p^a^t^c^h^e^d, ^c^o^m^m^i^t^t^e^d
 *
 *   PLUS the GM-28 truth-claim words (10 new):
 *     ^v^e^r^i^f^i^e^d, ^c^o^n^f^i^r^m^e^d, ^a^c^t^u^a^l,
 *     ^a^c^t^u^a^l^l^y, ^d^e^f^i^n^i^t^e^l^y, ^p^r^o^v^e^n,
 *     ^c^e^r^t^a^i^n, ^r^e^a^l, ^r^e^a^l^i^t^y, ^t^r^u^t^h
 *
 * (Fragments above written intentionally without the bare
 * identifier — see the boundary guard for the exact regex set.)
 *
 * The "ledger" in the filename is mandatory per OQ-28.13. It
 * makes the read-only / record-only nature visible at the file
 * level. This actor does NOT do the thing in its name; it writes
 * to an append-only ledger.
 *
 * The actor inherits the GM-22 through GM-27 verification chain
 * and adds actor-specific layers:
 *
 *   7.  params.userRole === 'admin'
 *   8.  params.authorizationScope ∈ AUTHORIZATION_SCOPES (from GM-25)
 *   9.  params.executionSurface ∈ EXECUTION_SURFACES (from GM-26)
 *   10. params.outcomeType ∈ EXECUTION_OUTCOME_TYPES (GM-28 NEW,
 *       4 values, all `reported_*` prefixed)
 *
 * Plus UUID validation on pilotInstanceId, userId,
 * executionAttemptId.
 *
 * The five DB-side data preconditions are enforced by the
 * BEFORE-INSERT trigger in
 * db/migrations/013_execution_outcomes.sql:
 *   (a) attempt exists in same pilot
 *   (b) authorization_scope equals the attempt's scope
 *   (c) execution_surface equals the attempt's surface
 *   (d) recorder ≠ attempter (self-recording forbidden, 5th
 *       separation-of-duties stage)
 *   (e) chain outcome → attempt → claim → authorization →
 *       review_decision resolves to review_outcome = 'approved'
 *
 * On the happy path the actor returns
 * {outcome: 'outcome_recorded', decision, outcomeId, createdAt}.
 *
 * What the actor does NOT do (and what mechanical defenses
 * prevent it from doing):
 *
 *   - Verify anything (I23-style canary I24 mechanically bans
 *     verification vocabulary in this file).
 *   - Reconcile against external state (no external surface
 *     exists).
 *   - Trigger any downstream action (no consumer of outcome rows
 *     in src/; J22 static-scan canary asserts).
 *   - Read the outcome row after writing.
 *   - Mutate any prior governance artifact.
 *   - Perform any other DB op (no UPDATE, no DELETE).
 *   - Notify external systems.
 *   - Schedule background work.
 *
 * Phantom outcomes remain an unresolved question: a missing
 * outcome row is structurally valid in GM-28. See
 * docs/governance/execution-outcome-runtime-boundary.md
 * "What remains unresolved" for the eight items the
 * future-consumer GM must address.
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
// The GM-28 locked outcome vocabulary. Every value is mandatorily
// `reported_*` prefixed. J37 snapshot test enforces. CHECK
// constraint in db/migrations/013_execution_outcomes.sql is
// authoritative.
const VALID_EXECUTION_OUTCOME_TYPES = new Set([
  'reported_completed',
  'reported_interrupted',
  'reported_abandoned',
  'reported_unknown',
]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isReviewQueuePool(handle) {
  return handle && (typeof handle === 'object' || typeof handle === 'function');
}

function verifyDecisionOrThrow(decision) {
  // Layer 1: instanceof.
  if (!(decision instanceof Decision)) {
    throw new Error(
      'execution-outcome-ledger actor: decision must be a Decision instance from classifyExecutionIntent'
    );
  }
  // Layer 2: WeakSet membership (closes prototype-tampering gap).
  if (!isValidDecision(decision)) {
    throw new Error(
      'execution-outcome-ledger actor: decision was not produced by classifyExecutionIntent (prototype tampering or forgery)'
    );
  }
  // Layer 3: frozen.
  if (!Object.isFrozen(decision)) {
    throw new Error('execution-outcome-ledger actor: decision must be frozen');
  }
  // Layer 4: intent-type. This actor accepts ONLY
  // governance.execution.outcome.record.
  if (decision.intentType !== INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD) {
    throw new Error(
      `execution-outcome-ledger actor: decision.intentType must be "${INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD}" (got "${decision.intentType}")`
    );
  }
  // Layer 5: structural revalidation of the locked vocabularies.
  if (!VALID_DECISION_OUTCOMES_SET.has(decision.decision)) {
    throw new Error('execution-outcome-ledger actor: decision.decision is not a valid outcome');
  }
  if (!VALID_REASONS.has(decision.reason)) {
    throw new Error('execution-outcome-ledger actor: decision.reason is not in REASONS');
  }
  if (typeof decision.policyRef !== 'string' || decision.policyRef.length === 0) {
    throw new Error('execution-outcome-ledger actor: decision.policyRef must be a non-empty string');
  }
  // Layer 6 (actor-specific): the classifier returns admissible
  // for governance.execution.outcome.record. Defense in depth.
  if (decision.decision !== DECISION_OUTCOMES.ADMISSIBLE) {
    throw new Error(
      `execution-outcome-ledger actor: decision.decision must be "admissible" (got "${decision.decision}")`
    );
  }
}

function validateParams(params) {
  if (!params || typeof params !== 'object') {
    throw new Error('execution-outcome-ledger actor: params object is required');
  }
  const {
    pilotInstanceId,
    userId,
    userRole,
    executionAttemptId,
    authorizationScope,
    executionSurface,
    outcomeType,
  } = params;
  if (typeof pilotInstanceId !== 'string' || !UUID_RE.test(pilotInstanceId)) {
    throw new Error('execution-outcome-ledger actor: pilotInstanceId must be a UUID');
  }
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new Error('execution-outcome-ledger actor: userId must be a UUID');
  }
  // Layer 7 (actor-specific): admin only.
  if (userRole !== 'admin') {
    throw new Error(
      `execution-outcome-ledger actor: userRole must be "admin" (got "${userRole}")`
    );
  }
  if (typeof executionAttemptId !== 'string' || !UUID_RE.test(executionAttemptId)) {
    throw new Error('execution-outcome-ledger actor: executionAttemptId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `execution-outcome-ledger actor: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_EXECUTION_SURFACES.has(executionSurface)) {
    throw new Error(
      `execution-outcome-ledger actor: executionSurface must be one of ${Array.from(VALID_EXECUTION_SURFACES).join(', ')}`
    );
  }
  if (!VALID_EXECUTION_OUTCOME_TYPES.has(outcomeType)) {
    throw new Error(
      `execution-outcome-ledger actor: outcomeType must be one of ${Array.from(VALID_EXECUTION_OUTCOME_TYPES).join(', ')}`
    );
  }
}

function createExecutionOutcomeLedgerActor(options) {
  if (!options || typeof options !== 'object') {
    throw new Error('createExecutionOutcomeLedgerActor: options object is required');
  }
  const { reviewQueuePool, log } = options;
  if (!isReviewQueuePool(reviewQueuePool)) {
    throw new Error(
      'createExecutionOutcomeLedgerActor: reviewQueuePool is required (obtain via createReviewQueuePool)'
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
      executionAttemptId,
      authorizationScope,
      executionSurface,
      outcomeType,
    } = params;

    const inserted = await withReviewContext(
      reviewQueuePool,
      { pilotInstanceId, userId, userRole },
      (ctx) =>
        ctx.recordExecutionOutcome({
          executionAttemptId,
          authorizationScope,
          executionSurface,
          outcomeType,
        })
    );

    if (logger) {
      // Metadata only — every field below is either a typed
      // identifier or a value from a locked vocabulary. No
      // free-text content.
      logger.info('actor.execution_outcome.recorded', {
        intent_type: decision.intentType,
        decision: decision.decision,
        reason: decision.reason,
        outcome_id: inserted.id,
        execution_attempt_id: executionAttemptId,
        authorization_scope: authorizationScope,
        execution_surface: executionSurface,
        outcome_type: outcomeType,
        recorded_by_user_id: userId,
        recorded_by_role: userRole,
      });
    }

    return Object.freeze({
      outcome: OUTCOMES.OUTCOME_RECORDED,
      decision,
      outcomeId: inserted.id,
      createdAt: inserted.created_at,
    });
  }

  return Object.freeze({ execute });
}

module.exports = { createExecutionOutcomeLedgerActor };
