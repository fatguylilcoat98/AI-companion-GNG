'use strict';
/*
 * Integration tests for the GM-29 execution-verification substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createExecutionVerificationLedgerActor
 *     → withReviewContext
 *       → recordExecutionVerification
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_execution_verifications
 *
 * Plus the K-series adversarial integration scenarios
 * (self-verification trigger, replay UNIQUE, missing-outcome
 * trigger, cross-pilot composite-FK rejection, append-only
 * enforcement, GRANT denial for lylo_runtime, CHECK rejection
 * of smuggled verification vocabulary).
 *
 * Constitutional rule: VERIFICATION ≠ RECONCILIATION ≠ REPAIR.
 */

const test = require('node:test');
const before = test.before;
const after = test.after;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const { createReviewQueuePool, closeReviewQueuePool, withReviewContext } = require('../../src/review');
const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  createExecutionAttemptLedgerActor,
  createExecutionOutcomeLedgerActor,
  createExecutionVerificationLedgerActor,
  OUTCOMES,
} = require('../../src/actors');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const ADMIN4_A = 'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa';
const ADMIN5_A = 'aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa';
const ADMIN6_A = 'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa';

let reviewPool;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(LYLO_APP_DATABASE_URL, 'LYLO_APP_DATABASE_URL must be set');

  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  await client.query(
    fs.readFileSync(path.join(REPO, 'tests', 'rls-contract', 'fixtures.sql'), 'utf8')
  );
  await client.end();

  reviewPool = createReviewQueuePool(LYLO_APP_DATABASE_URL, { max: 3 });
});

after(async () => {
  if (reviewPool) await closeReviewQueuePool(reviewPool);
});

async function rowCount() {
  const su = new Client({ connectionString: DATABASE_URL });
  await su.connect();
  try {
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_execution_verifications');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function verifyDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY });
}

// Helper: stage -> review -> authorize -> claim -> attempt ->
// record outcome. Returns the new execution_outcome_id.
// Reviewer = ADMIN_A; authorizer = ADMIN2_A; claimant = ADMIN3_A;
// attempter = ADMIN4_A; recorder = ADMIN5_A. The verifier in
// tests is ADMIN6_A so verifier != recorder naturally.
async function fullChainThroughOutcome({ payloadHint, outcomeType }) {
  const stagingActor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  const staged = await stagingActor.execute(requires, {
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior',
    payloadSummary: { content: payloadHint, provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'integration' },
  });
  const reviewActor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decideDecision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  const reviewed = await reviewActor.execute(decideDecision, {
    pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin',
    reviewQueueId: staged.queueEntryId,
    reviewOutcome: 'approved', reviewReason: 'approved_admin_review',
  });
  const authActor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const authDecision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
  const authorized = await authActor.execute(authDecision, {
    pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
    reviewDecisionId: reviewed.reviewDecisionId,
    authorizationScope: 'memory_candidate_admission',
    authorizationReason: 'admin_explicit_authorization',
  });
  const claimActor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const claimDec = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
  const claimed = await claimActor.execute(claimDec, {
    pilotInstanceId: PILOT_A, userId: ADMIN3_A, userRole: 'admin',
    executionAuthorizationId: authorized.authorizationId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  const attemptActor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const attemptDec = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
  const attempted = await attemptActor.execute(attemptDec, {
    pilotInstanceId: PILOT_A, userId: ADMIN4_A, userRole: 'admin',
    executionClaimId: claimed.claimId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  const outcomeActor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const outcomeDec = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
  const recorded = await outcomeActor.execute(outcomeDec, {
    pilotInstanceId: PILOT_A, userId: ADMIN5_A, userRole: 'admin',
    executionAttemptId: attempted.attemptId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
    outcomeType: outcomeType || 'reported_completed',
  });
  return recorded.outcomeId;
}

// ---- happy path ----

test('execution-verification integration: admin6 records verified_consistent against an admin5-recorded outcome', async () => {
  const outcomeId = await fullChainThroughOutcome({ payloadHint: 'happy-path verify' });
  const before = await rowCount();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: reviewPool });
  const decision = verifyDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN6_A,
    userRole: 'admin',
    executionOutcomeId: outcomeId,
    verificationType: 'database_state_check',
    verificationResult: 'verified_consistent',
  });
  assert.equal(result.outcome, OUTCOMES.VERIFICATION_RECORDED);
  assert.match(result.verificationId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const inspect = await ctx.inspectExecutionVerification(result.verificationId);
      assert.ok(inspect, 'admin must see the verification row');
      assert.equal(inspect.execution_outcome_id, outcomeId);
      assert.equal(inspect.verified_by_user_id, ADMIN6_A);
      assert.equal(inspect.verification_type, 'database_state_check');
      assert.equal(inspect.verification_result, 'verified_consistent');
    }
  );
});

test('execution-verification integration: every verification_result is accepted', async () => {
  const results = ['verified_consistent', 'verified_inconsistent', 'verification_inconclusive'];
  for (const verificationResult of results) {
    const outcomeId = await fullChainThroughOutcome({ payloadHint: `result ${verificationResult}` });
    const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: reviewPool });
    const decision = verifyDecision();
    const result = await actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN6_A,
      userRole: 'admin',
      executionOutcomeId: outcomeId,
      verificationType: 'human_observation',
      verificationResult,
    });
    assert.equal(result.outcome, OUTCOMES.VERIFICATION_RECORDED);
  }
});

test('execution-verification integration: senior cannot SELECT the verification', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id FROM governance_execution_verifications');
    assert.deepEqual(r.rows, [], 'senior must see no verification rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- K-series counterparts ----

test('execution-verification integration: self-verification rejected by BEFORE-INSERT trigger', async () => {
  // admin5 recorded; admin5 then tries to verify the same outcome.
  const outcomeId = await fullChainThroughOutcome({ payloadHint: 'self-verify probe' });
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: reviewPool });
  const decision = verifyDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A, // same human who recorded the outcome
      userRole: 'admin',
      executionOutcomeId: outcomeId,
      verificationType: 'human_observation',
      verificationResult: 'verified_consistent',
    }),
    /self-verification forbidden|review operation failed/i
  );
});

test('execution-verification integration: replay (double verification) rejected (UNIQUE)', async () => {
  const outcomeId = await fullChainThroughOutcome({ payloadHint: 'replay verify' });
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: reviewPool });
  const decision = verifyDecision();
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN6_A,
    userRole: 'admin',
    executionOutcomeId: outcomeId,
    verificationType: 'human_observation',
    verificationResult: 'verified_consistent',
  });
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN6_A,
      userRole: 'admin',
      executionOutcomeId: outcomeId,
      verificationType: 'system_log_review',
      verificationResult: 'verification_inconclusive',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('execution-verification integration: cross-pilot execution_outcome_id rejected', async () => {
  // Fixture seeds a pilot-B outcome; try to record a verification from pilot A.
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: reviewPool });
  const decision = verifyDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN6_A,
      userRole: 'admin',
      executionOutcomeId: 'bbbbbbbb-9999-2222-2222-f00000000001',
      verificationType: 'human_observation',
      verificationResult: 'verified_consistent',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed|not found/i
  );
});

test('execution-verification integration: lylo_app cannot UPDATE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_execution_verifications SET verification_result = 'verification_inconclusive'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-verification integration: lylo_app cannot DELETE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_execution_verifications'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-verification integration: lylo_runtime denied at GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_execution_verifications'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-verification integration: CHECK rejects smuggled `verified_completed` at the DB layer', async () => {
  // The actor layer rejects this first; here we prove the DB
  // CHECK is also independently enforced by bypassing the actor
  // and going through the lylo_app role directly. The CHECK
  // lives on verification_result and rejects anything outside
  // the 3-value vocabulary.
  const outcomeId = await fullChainThroughOutcome({ payloadHint: 'CHECK probe verify' });
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', ADMIN6_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'admin']);
    await assert.rejects(
      () => raw.query(
        `INSERT INTO governance_execution_verifications
           (pilot_instance_id, execution_outcome_id, verified_by_user_id,
            verified_by_role, verification_type, verification_result)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [PILOT_A, outcomeId, ADMIN6_A, 'admin', 'human_observation', 'verified_completed']
      ),
      /check constraint|verification_result/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

test('execution-verification integration: listExecutionVerifications returns rows visible to admin', async () => {
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const verifications = await ctx.listExecutionVerifications({ limit: 50 });
      assert.ok(verifications.length >= 1, 'admin must see at least the seeded verification');
      const fixtureSeed = verifications.find((v) => v.id === 'aaaaaaaa-8888-1111-1111-100000000001');
      assert.ok(fixtureSeed, 'seeded VERIFICATION_A must appear');
      assert.equal(fixtureSeed.verified_by_role, 'admin');
      assert.equal(fixtureSeed.verification_type, 'database_state_check');
      assert.equal(fixtureSeed.verification_result, 'verified_consistent');
    }
  );
});
