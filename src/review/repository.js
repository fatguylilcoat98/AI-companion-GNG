'use strict';
/*
 * Review repository — GM-23 (stageReviewItem) + GM-24 (review-
 * decision read + write).
 *
 * Every operation is invoked through the ctx the caller receives
 * from withReviewContext; the raw pg client is intentionally NOT
 * exposed.
 *
 * Hard rules (GM-23):
 *   - stageReviewItem: single INSERT into governance_review_queue.
 *     No SELECT, no UPDATE, no DELETE (append-only + no grants).
 *   - status set to its default ('pending_review') at the DB layer.
 *   - Decision-shape verification lives in the review-queue actor;
 *     this module is persistence, the actor is the gate.
 *   - proposer_user_id + pilot_instance_id come from session
 *     context, not input — RLS WITH CHECK enforces no-impersonation.
 *
 * Hard rules (GM-24):
 *   - listPendingReviewItems / inspectReviewItem: SELECT-only
 *     reads of governance_review_queue, narrowed by RLS to admin +
 *     proposer (GM-23 policies).
 *   - recordReviewDecision: single INSERT into
 *     governance_review_decisions. reviewer_user_id +
 *     pilot_instance_id come from session context. Vocabulary
 *     validated locally before the round-trip; CHECK constraints
 *     are the authoritative wall. The self-review BEFORE-INSERT
 *     trigger refuses if reviewer == proposer.
 *   - No UPDATE / DELETE op exists for the new table either; the
 *     module has no grants for them.
 *
 * payload_summary and evidence_summary on the queue are passed
 * through to listPending / inspect as JSONB (the underlying pg
 * driver returns them as already-parsed JS objects). Callers
 * decide what to render; the module does not log them.
 */

const VALID_DECISION_INTENT_TYPES = new Set([
  'response.deliver',
  'memory.candidate.create',
  'memory.visibility.promote',
  'memory.retract',
  'memory.supersede',
  'vault.session.open',
  'vault.session.revoke',
  'external.side_effect',
]);

const VALID_DECISION_REASONS = new Set([
  'response_delivery_permitted',
  'ai_inferred_requires_review',
  'user_stated_requires_review',
  'verified_fact_self_promotion_forbidden',
  'visibility_promotion_requires_authority',
  'retraction_infrastructure_not_available',
  'supersession_infrastructure_not_available',
  'vault_infrastructure_not_available',
  'external_side_effects_not_authorized',
  'unknown_intent_type',
  'malformed_intent_payload',
]);

const VALID_PROPOSER_ROLES = new Set([
  'senior', 'family', 'caregiver', 'admin', 'system',
]);

// GM-24: locked review-outcome and review-reason vocabularies.
// Mirrors the CHECK constraints in db/migrations/009_review_decisions.sql.
// Any change requires a paired migration + paired snapshot test.
const VALID_REVIEW_OUTCOMES = new Set(['approved', 'rejected']);

const VALID_REVIEW_REASONS = new Set([
  'approved_admin_review',
  'rejected_insufficient_evidence',
  'rejected_policy_violation',
  'rejected_duplicate',
  'rejected_admin_review',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Per OQ-24.11(a) the read defaults to a small bounded limit. The
// caller may pass an explicit cap; the hard ceiling is 200 to keep
// any single round-trip bounded.
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

async function stageReviewItem(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('stageReviewItem: input is required');
  }
  const {
    decisionIntentType,
    decisionReason,
    decisionPolicyRef,
    proposerRole,
    payloadSummary,
    evidenceSummary,
  } = input;

  if (!VALID_DECISION_INTENT_TYPES.has(decisionIntentType)) {
    throw new Error(
      `stageReviewItem: decisionIntentType must be one of ${Array.from(VALID_DECISION_INTENT_TYPES).join(', ')}`
    );
  }
  if (!VALID_DECISION_REASONS.has(decisionReason)) {
    throw new Error(
      `stageReviewItem: decisionReason must be one of ${Array.from(VALID_DECISION_REASONS).join(', ')}`
    );
  }
  if (typeof decisionPolicyRef !== 'string' || decisionPolicyRef.length === 0) {
    throw new Error('stageReviewItem: decisionPolicyRef must be a non-empty string');
  }
  if (!VALID_PROPOSER_ROLES.has(proposerRole)) {
    throw new Error(
      `stageReviewItem: proposerRole must be one of ${Array.from(VALID_PROPOSER_ROLES).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO governance_review_queue '
      + '(pilot_instance_id, decision_intent_type, decision_reason, '
      + 'decision_policy_ref, proposer_user_id, proposer_role, '
      + 'payload_summary, evidence_summary) '
      + 'VALUES ($1, $2, $3, $4, $5, $6, $7, $8) '
      + 'RETURNING id, created_at',
    [
      sessionCtx.pilotInstanceId,
      decisionIntentType,
      decisionReason,
      decisionPolicyRef,
      sessionCtx.userId,
      proposerRole,
      payloadSummary === undefined ? null : JSON.stringify(payloadSummary),
      evidenceSummary === undefined ? null : JSON.stringify(evidenceSummary),
    ]
  );

  return {
    id: inserted.rows[0].id,
    created_at: inserted.rows[0].created_at,
  };
}

// ---------------------------------------------------------------------
// GM-24: review-decision read + write surface.
// ---------------------------------------------------------------------

// listPendingReviewItems — return queue rows in the pilot that have
// NO matching governance_review_decisions row (i.e. pending review).
// RLS narrows to admin (via review_queue_admin SELECT policy) or
// proposer (via review_queue_proposer SELECT policy). The actor
// enforces admin-only role on top.
//
// The LEFT JOIN on review_decisions filters out already-reviewed
// items; the WHERE rd.id IS NULL clause is what makes "pending"
// mechanical without exposing review_decisions content to the
// listing operator.
async function listPendingReviewItems(client, sessionCtx, options) {
  const opts = options || {};
  const requestedLimit = opts.limit;
  let limit = DEFAULT_LIST_LIMIT;
  if (requestedLimit !== undefined) {
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('listPendingReviewItems: limit must be a positive integer');
    }
    limit = Math.min(requestedLimit, MAX_LIST_LIMIT);
  }
  const result = await client.query(
    'SELECT q.id, q.decision_intent_type, q.decision_reason, '
      + 'q.decision_policy_ref, q.proposer_user_id, q.proposer_role, '
      + 'q.status, q.created_at '
      + 'FROM governance_review_queue q '
      + 'LEFT JOIN governance_review_decisions rd '
      + '  ON rd.review_queue_id = q.id '
      + ' AND rd.pilot_instance_id = q.pilot_instance_id '
      + 'WHERE rd.id IS NULL '
      + 'ORDER BY q.created_at ASC '
      + 'LIMIT $1',
    [limit]
  );
  return result.rows;
}

// inspectReviewItem — return one queue row (including payload +
// evidence summaries) by id. RLS narrows by pilot + role; the
// caller already obtained the id from listPendingReviewItems or
// from out-of-band context. Returns null if not visible.
async function inspectReviewItem(client, sessionCtx, queueId) {
  if (typeof queueId !== 'string' || !UUID_RE.test(queueId)) {
    throw new Error('inspectReviewItem: queueId must be a UUID');
  }
  const result = await client.query(
    'SELECT id, decision_intent_type, decision_reason, '
      + 'decision_policy_ref, proposer_user_id, proposer_role, '
      + 'payload_summary, evidence_summary, status, created_at '
      + 'FROM governance_review_queue '
      + 'WHERE id = $1',
    [queueId]
  );
  return result.rows.length === 0 ? null : result.rows[0];
}

// recordReviewDecision — single INSERT into
// governance_review_decisions. The actor (src/actors/review-decision-actor.js)
// is responsible for the seven-layer Decision verification + admin
// role check; this function performs vocabulary validation and the
// INSERT. reviewer_user_id + pilot_instance_id ALWAYS come from
// session context (never from input) — RLS WITH CHECK enforces
// no-impersonation, the BEFORE-INSERT trigger enforces no-self-review.
async function recordReviewDecision(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('recordReviewDecision: input is required');
  }
  const { reviewQueueId, reviewOutcome, reviewReason } = input;

  if (typeof reviewQueueId !== 'string' || !UUID_RE.test(reviewQueueId)) {
    throw new Error('recordReviewDecision: reviewQueueId must be a UUID');
  }
  if (!VALID_REVIEW_OUTCOMES.has(reviewOutcome)) {
    throw new Error(
      `recordReviewDecision: reviewOutcome must be one of ${Array.from(VALID_REVIEW_OUTCOMES).join(', ')}`
    );
  }
  if (!VALID_REVIEW_REASONS.has(reviewReason)) {
    throw new Error(
      `recordReviewDecision: reviewReason must be one of ${Array.from(VALID_REVIEW_REASONS).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO governance_review_decisions '
      + '(pilot_instance_id, review_queue_id, reviewer_user_id, '
      + 'reviewer_role, review_outcome, review_reason) '
      + 'VALUES ($1, $2, $3, $4, $5, $6) '
      + 'RETURNING id, reviewed_at',
    [
      sessionCtx.pilotInstanceId,
      reviewQueueId,
      sessionCtx.userId,
      sessionCtx.userRole,
      reviewOutcome,
      reviewReason,
    ]
  );

  return {
    id: inserted.rows[0].id,
    reviewed_at: inserted.rows[0].reviewed_at,
  };
}

// ---------------------------------------------------------------------
// GM-25: execution-authorization read + write surface.
// ---------------------------------------------------------------------

// Mirrors the GM-24 review_outcome / review_reason locked
// vocabularies. CHECK constraints in
// db/migrations/010_execution_authorizations.sql are authoritative.
const VALID_AUTHORIZATION_SCOPES = new Set([
  'memory_candidate_admission',
  'future_external_action',
  'future_visibility_change',
  'future_vault_action',
]);

const VALID_AUTHORIZATION_REASONS = new Set([
  'admin_explicit_authorization',
]);

const VALID_AUTHORIZATION_ROLES = new Set(['admin']);

// recordExecutionAuthorization — single INSERT into
// governance_execution_authorizations. The actor
// (src/actors/execution-authorization-actor.js) is responsible
// for the eight-layer Decision verification + admin role check;
// this function performs vocabulary validation and the INSERT.
// authorized_by_user_id + pilot_instance_id ALWAYS come from
// session context (never from input) — RLS WITH CHECK enforces
// no-impersonation; the BEFORE-INSERT trigger enforces the
// four data preconditions (review exists, approved, no self-
// authorization, scope ↔ intent).
async function recordExecutionAuthorization(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('recordExecutionAuthorization: input is required');
  }
  const { reviewDecisionId, authorizationScope, authorizationReason } = input;

  if (typeof reviewDecisionId !== 'string' || !UUID_RE.test(reviewDecisionId)) {
    throw new Error('recordExecutionAuthorization: reviewDecisionId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `recordExecutionAuthorization: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_AUTHORIZATION_REASONS.has(authorizationReason)) {
    throw new Error(
      `recordExecutionAuthorization: authorizationReason must be one of ${Array.from(VALID_AUTHORIZATION_REASONS).join(', ')}`
    );
  }
  // sessionCtx.userRole is also constrained at the actor layer
  // (must be 'admin'); the repository asserts it again so a future
  // caller that bypasses the actor still gets a clean failure.
  if (!VALID_AUTHORIZATION_ROLES.has(sessionCtx.userRole)) {
    throw new Error(
      `recordExecutionAuthorization: sessionCtx.userRole must be one of ${Array.from(VALID_AUTHORIZATION_ROLES).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO governance_execution_authorizations '
      + '(pilot_instance_id, review_decision_id, authorized_by_user_id, '
      + 'authorized_by_role, authorization_scope, authorization_reason) '
      + 'VALUES ($1, $2, $3, $4, $5, $6) '
      + 'RETURNING id, created_at',
    [
      sessionCtx.pilotInstanceId,
      reviewDecisionId,
      sessionCtx.userId,
      sessionCtx.userRole,
      authorizationScope,
      authorizationReason,
    ]
  );

  return {
    id: inserted.rows[0].id,
    created_at: inserted.rows[0].created_at,
  };
}

// listExecutionAuthorizations — admin-only listing. RLS narrows to
// admin (auth_admin_select) — the actor enforces admin role at
// the seventh verification layer; this read is the operator-audit
// path. Returns up to `limit` rows, ordered newest first.
async function listExecutionAuthorizations(client, sessionCtx, options) {
  const opts = options || {};
  const requestedLimit = opts.limit;
  let limit = DEFAULT_LIST_LIMIT;
  if (requestedLimit !== undefined) {
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('listExecutionAuthorizations: limit must be a positive integer');
    }
    limit = Math.min(requestedLimit, MAX_LIST_LIMIT);
  }
  const result = await client.query(
    'SELECT id, review_decision_id, authorized_by_user_id, '
      + 'authorized_by_role, authorization_scope, authorization_reason, '
      + 'created_at '
      + 'FROM governance_execution_authorizations '
      + 'ORDER BY created_at DESC '
      + 'LIMIT $1',
    [limit]
  );
  return result.rows;
}

// inspectExecutionAuthorization — admin-only single-row lookup.
// Returns null if not visible under the current RLS context.
async function inspectExecutionAuthorization(client, sessionCtx, authorizationId) {
  if (typeof authorizationId !== 'string' || !UUID_RE.test(authorizationId)) {
    throw new Error('inspectExecutionAuthorization: authorizationId must be a UUID');
  }
  const result = await client.query(
    'SELECT id, review_decision_id, authorized_by_user_id, '
      + 'authorized_by_role, authorization_scope, authorization_reason, '
      + 'created_at '
      + 'FROM governance_execution_authorizations '
      + 'WHERE id = $1',
    [authorizationId]
  );
  return result.rows.length === 0 ? null : result.rows[0];
}

// ---------------------------------------------------------------------
// GM-26: execution-claim read + write surface.
// ---------------------------------------------------------------------

// EXECUTION_SURFACES is the GM-26 locked vocabulary. Every value
// MUST be `future_*` prefixed — the constitutional discipline that
// puts "no consumer exists yet" into the data itself. Adding a
// non-prefixed value fails the H27 prefix-discipline snapshot
// test in tests/governance/adversarial.test.js. CHECK constraint
// in db/migrations/011_execution_claims.sql is authoritative.
const VALID_EXECUTION_SURFACES = new Set([
  'future_memory_admission_consumer',
  'future_external_action_consumer',
  'future_visibility_change_consumer',
  'future_vault_action_consumer',
]);

const VALID_CLAIM_ROLES = new Set(['admin']);

// Surface ↔ scope 1:1 mapping. Locked here as JS defense-in-depth
// for the actor's pre-INSERT check. The DB BEFORE-INSERT trigger
// is the authoritative wall; this mapping mirrors the trigger's
// CASE statement.
const EXECUTION_SURFACE_FOR_SCOPE = Object.freeze({
  memory_candidate_admission: 'future_memory_admission_consumer',
  future_external_action:     'future_external_action_consumer',
  future_visibility_change:   'future_visibility_change_consumer',
  future_vault_action:        'future_vault_action_consumer',
});

// recordExecutionClaim — single INSERT into
// governance_execution_claims. The actor
// (src/actors/execution-claim-ledger-actor.js) is responsible for
// the ten-layer Decision verification + admin role check; this
// function performs vocabulary validation and the INSERT.
// claimed_by_user_id + pilot_instance_id ALWAYS come from session
// context — RLS WITH CHECK enforces no-impersonation; the
// BEFORE-INSERT trigger enforces the five data preconditions
// (authorization exists, scope equality, self-claim forbidden,
// surface fits scope, upstream review still approved).
async function recordExecutionClaim(client, sessionCtx, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('recordExecutionClaim: input is required');
  }
  const { executionAuthorizationId, authorizationScope, executionSurface } = input;

  if (typeof executionAuthorizationId !== 'string' || !UUID_RE.test(executionAuthorizationId)) {
    throw new Error('recordExecutionClaim: executionAuthorizationId must be a UUID');
  }
  if (!VALID_AUTHORIZATION_SCOPES.has(authorizationScope)) {
    throw new Error(
      `recordExecutionClaim: authorizationScope must be one of ${Array.from(VALID_AUTHORIZATION_SCOPES).join(', ')}`
    );
  }
  if (!VALID_EXECUTION_SURFACES.has(executionSurface)) {
    throw new Error(
      `recordExecutionClaim: executionSurface must be one of ${Array.from(VALID_EXECUTION_SURFACES).join(', ')}`
    );
  }
  if (!VALID_CLAIM_ROLES.has(sessionCtx.userRole)) {
    throw new Error(
      `recordExecutionClaim: sessionCtx.userRole must be one of ${Array.from(VALID_CLAIM_ROLES).join(', ')}`
    );
  }

  const inserted = await client.query(
    'INSERT INTO governance_execution_claims '
      + '(pilot_instance_id, execution_authorization_id, authorization_scope, '
      + 'execution_surface, claimed_by_user_id, claimed_by_role) '
      + 'VALUES ($1, $2, $3, $4, $5, $6) '
      + 'RETURNING id, created_at',
    [
      sessionCtx.pilotInstanceId,
      executionAuthorizationId,
      authorizationScope,
      executionSurface,
      sessionCtx.userId,
      sessionCtx.userRole,
    ]
  );

  return {
    id: inserted.rows[0].id,
    created_at: inserted.rows[0].created_at,
  };
}

// listExecutionClaims — admin-only listing. RLS narrows by pilot +
// admin role. Bounded by DEFAULT_LIST_LIMIT / MAX_LIST_LIMIT.
async function listExecutionClaims(client, sessionCtx, options) {
  const opts = options || {};
  const requestedLimit = opts.limit;
  let limit = DEFAULT_LIST_LIMIT;
  if (requestedLimit !== undefined) {
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1) {
      throw new Error('listExecutionClaims: limit must be a positive integer');
    }
    limit = Math.min(requestedLimit, MAX_LIST_LIMIT);
  }
  const result = await client.query(
    'SELECT id, execution_authorization_id, authorization_scope, '
      + 'execution_surface, claimed_by_user_id, claimed_by_role, created_at '
      + 'FROM governance_execution_claims '
      + 'ORDER BY created_at DESC '
      + 'LIMIT $1',
    [limit]
  );
  return result.rows;
}

// inspectExecutionClaim — admin-only single-row lookup. Returns
// null if not visible under the current RLS context.
async function inspectExecutionClaim(client, sessionCtx, claimId) {
  if (typeof claimId !== 'string' || !UUID_RE.test(claimId)) {
    throw new Error('inspectExecutionClaim: claimId must be a UUID');
  }
  const result = await client.query(
    'SELECT id, execution_authorization_id, authorization_scope, '
      + 'execution_surface, claimed_by_user_id, claimed_by_role, created_at '
      + 'FROM governance_execution_claims '
      + 'WHERE id = $1',
    [claimId]
  );
  return result.rows.length === 0 ? null : result.rows[0];
}

module.exports = {
  stageReviewItem,
  listPendingReviewItems,
  inspectReviewItem,
  recordReviewDecision,
  recordExecutionAuthorization,
  listExecutionAuthorizations,
  inspectExecutionAuthorization,
  recordExecutionClaim,
  listExecutionClaims,
  inspectExecutionClaim,
  VALID_DECISION_INTENT_TYPES,
  VALID_DECISION_REASONS,
  VALID_PROPOSER_ROLES,
  VALID_REVIEW_OUTCOMES,
  VALID_REVIEW_REASONS,
  VALID_AUTHORIZATION_SCOPES,
  VALID_AUTHORIZATION_REASONS,
  VALID_AUTHORIZATION_ROLES,
  VALID_EXECUTION_SURFACES,
  VALID_CLAIM_ROLES,
  EXECUTION_SURFACE_FOR_SCOPE,
};
