'use strict';
/*
 * Fixture reset + chain.through.* helpers.
 *
 * Per OQ-30.5: drop schema + re-apply all migrations + re-apply
 * tests/rls-contract/fixtures.sql per scenario. Matches the
 * integration-tests CI pattern.
 *
 * The chain.through.* helpers drive the six prior substrate
 * actors end-to-end so a scenario can target the verification
 * layer without re-staging the entire chain in its setup
 * array. Each helper is named exactly as it appears in the
 * scenario's setup vocabulary (per schema.js SETUP_OPS), and
 * each goes through the public actor + ctx surface — NEVER
 * through repository internals (per OQ-30.4).
 */

// Note: this module is invoked by tests that have already
// required `pg` to apply migrations via the bootstrap
// superuser. The gauntlet itself never imports `pg`; the test
// runner does so once at startup and hands the gauntlet a
// pre-built reviewPool obtained via createReviewQueuePool.

const { classifyExecutionIntent, INTENT_TYPES } = require('../governance');
const {
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  createExecutionAttemptLedgerActor,
  createExecutionOutcomeLedgerActor,
} = require('../actors');

// Pilot A fixture identities (mirror tests/rls-contract/fixtures.sql).
const PILOT_A = '11111111-1111-1111-1111-111111111111';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const ADMIN4_A = 'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa';
const ADMIN5_A = 'aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa';

// State carried through a scenario's setup chain. The runner
// passes this state into successive setup ops so the harness
// can reference, e.g., $lastOutcomeId in the step.params.
function newChainState() {
  return {
    queueEntryId: null,
    reviewDecisionId: null,
    authorizationId: null,
    claimId: null,
    attemptId: null,
    outcomeId: null,
  };
}

async function chainThroughQueue(reviewPool, state, opts) {
  const actor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  const staged = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: SENIOR_A,
    userRole: 'senior',
    payloadSummary: { content: (opts && opts.payloadHint) || 'gauntlet probe', provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'gauntlet' },
  });
  state.queueEntryId = staged.queueEntryId;
  return state;
}

async function chainThroughDecision(reviewPool, state) {
  if (!state.queueEntryId) throw new Error('chain.through.decision: prior chain.through.queue required');
  const actor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  const reviewed = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN_A,
    userRole: 'admin',
    reviewQueueId: state.queueEntryId,
    reviewOutcome: 'approved',
    reviewReason: 'approved_admin_review',
  });
  state.reviewDecisionId = reviewed.reviewDecisionId;
  return state;
}

async function chainThroughAuthorization(reviewPool, state) {
  if (!state.reviewDecisionId) throw new Error('chain.through.authorization: prior chain.through.decision required');
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  const authorized = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN2_A,
    userRole: 'admin',
    reviewDecisionId: state.reviewDecisionId,
    authorizationScope: 'memory_candidate_admission',
    authorizationReason: 'admin_explicit_authorization',
  });
  state.authorizationId = authorized.authorizationId;
  return state;
}

async function chainThroughClaim(reviewPool, state) {
  if (!state.authorizationId) throw new Error('chain.through.claim: prior chain.through.authorization required');
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  const claimed = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN3_A,
    userRole: 'admin',
    executionAuthorizationId: state.authorizationId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  state.claimId = claimed.claimId;
  return state;
}

async function chainThroughAttempt(reviewPool, state) {
  if (!state.claimId) throw new Error('chain.through.attempt: prior chain.through.claim required');
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  const attempted = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN4_A,
    userRole: 'admin',
    executionClaimId: state.claimId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  state.attemptId = attempted.attemptId;
  return state;
}

async function chainThroughOutcome(reviewPool, state, opts) {
  if (!state.attemptId) throw new Error('chain.through.outcome: prior chain.through.attempt required');
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const intent = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
  const recorded = await actor.execute(intent, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN5_A,
    userRole: 'admin',
    executionAttemptId: state.attemptId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
    outcomeType: (opts && opts.outcomeType) || 'reported_completed',
  });
  state.outcomeId = recorded.outcomeId;
  return state;
}

const SETUP_DISPATCH = Object.freeze({
  'chain.through.queue': chainThroughQueue,
  'chain.through.decision': chainThroughDecision,
  'chain.through.authorization': chainThroughAuthorization,
  'chain.through.claim': chainThroughClaim,
  'chain.through.attempt': chainThroughAttempt,
  'chain.through.outcome': chainThroughOutcome,
});

module.exports = {
  newChainState,
  SETUP_DISPATCH,
  PILOT_A, SENIOR_A, ADMIN_A, ADMIN2_A, ADMIN3_A, ADMIN4_A, ADMIN5_A,
};
