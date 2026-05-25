'use strict';
/*
 * Integration tests for the GM-28 execution-outcome substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createExecutionOutcomeLedgerActor
 *     → withReviewContext
 *       → recordExecutionOutcome
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_execution_outcomes
 *
 * Plus the J-series adversarial integration scenarios
 * (self-recording trigger, replay UNIQUE, scope-drift trigger,
 * surface-drift trigger, cross-pilot composite-FK rejection,
 * append-only enforcement, GRANT denial for lylo_runtime,
 * CHECK rejection of non-reported_* vocabulary).
 *
 * Constitutional rule: AN OUTCOME ROW IS NOT TRUTH.
 * `reported_completed` ≠ `verified_completed`.
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
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_execution_outcomes');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function outcomeDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
}

// Helper: stage → approve → authorize → claim → attempt. Returns
// the new execution_attempt_id. Reviewer = ADMIN_A; authorizer =
// ADMIN2_A; claimant = ADMIN3_A; attempter = ADMIN4_A. The
// recorder in tests is ADMIN5_A so recorder ≠ attempter naturally.
async function stageApproveAuthorizeClaimAttempt({ payloadHint }) {
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
  return attempted.attemptId;
}

// ---- happy path ----

test('execution-outcome integration: admin5 records reported_completed against an admin4-attempted item; row visible to admin', async () => {
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'happy-path candidate' });
  const before = await rowCount();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN5_A,
    userRole: 'admin',
    executionAttemptId: attemptId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
    outcomeType: 'reported_completed',
  });
  assert.equal(result.outcome, OUTCOMES.OUTCOME_RECORDED);
  assert.match(result.outcomeId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const inspect = await ctx.inspectExecutionOutcome(result.outcomeId);
      assert.ok(inspect, 'admin must see the outcome row');
      assert.equal(inspect.execution_attempt_id, attemptId);
      assert.equal(inspect.recorded_by_user_id, ADMIN5_A);
      assert.equal(inspect.authorization_scope, 'memory_candidate_admission');
      assert.equal(inspect.execution_surface, 'future_memory_admission_consumer');
      assert.equal(inspect.outcome_type, 'reported_completed');
    }
  );
});

test('execution-outcome integration: every reported_* vocabulary value is accepted', async () => {
  const values = ['reported_completed', 'reported_interrupted', 'reported_abandoned', 'reported_unknown'];
  for (const outcomeType of values) {
    const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: `vocab ${outcomeType}` });
    const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
    const decision = outcomeDecision();
    const result = await actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A,
      userRole: 'admin',
      executionAttemptId: attemptId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
      outcomeType,
    });
    assert.equal(result.outcome, OUTCOMES.OUTCOME_RECORDED);
  }
});

test('execution-outcome integration: senior (proposer) cannot SELECT the outcome', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id FROM governance_execution_outcomes');
    assert.deepEqual(r.rows, [], 'senior must see no outcome rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- J-series counterparts ----

test('execution-outcome integration: self-recording rejected by BEFORE-INSERT trigger', async () => {
  // admin4 attempted; admin4 then tries to record an outcome against the same attempt.
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'self-record attempt' });
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN4_A, // same human who attempted
      userRole: 'admin',
      executionAttemptId: attemptId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
      outcomeType: 'reported_completed',
    }),
    /self.recording forbidden|review operation failed/i
  );
});

test('execution-outcome integration: replay (double outcome) rejected (UNIQUE)', async () => {
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'replay outcome' });
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN5_A,
    userRole: 'admin',
    executionAttemptId: attemptId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
    outcomeType: 'reported_completed',
  });
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A,
      userRole: 'admin',
      executionAttemptId: attemptId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
      outcomeType: 'reported_unknown',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('execution-outcome integration: scope drift rejected by trigger', async () => {
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'scope-drift outcome' });
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A,
      userRole: 'admin',
      executionAttemptId: attemptId,
      authorizationScope: 'future_vault_action',
      executionSurface: 'future_vault_action_consumer',
      outcomeType: 'reported_completed',
    }),
    /authorization_scope drift|review operation failed/i
  );
});

test('execution-outcome integration: surface drift rejected by trigger', async () => {
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'surface-drift outcome' });
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A,
      userRole: 'admin',
      executionAttemptId: attemptId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_vault_action_consumer',
      outcomeType: 'reported_completed',
    }),
    /execution_surface drift|review operation failed/i
  );
});

test('execution-outcome integration: cross-pilot execution_attempt_id rejected', async () => {
  // Fixture seeds a pilot-B attempt; try to record an outcome from pilot A against it.
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: reviewPool });
  const decision = outcomeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN5_A,
      userRole: 'admin',
      executionAttemptId: 'bbbbbbbb-aaaa-2222-2222-d00000000001',
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
      outcomeType: 'reported_completed',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed/i
  );
});

test('execution-outcome integration: lylo_app cannot UPDATE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_execution_outcomes SET outcome_type = 'reported_unknown'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-outcome integration: lylo_app cannot DELETE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_execution_outcomes'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-outcome integration: lylo_runtime denied at GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_execution_outcomes'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-outcome integration: CHECK rejects non-reported_* vocabulary at the DB layer', async () => {
  // The actor layer rejects this first; here we prove the DB
  // CHECK is also independently enforced by bypassing the actor
  // and going through the lylo_app role directly with a smuggled
  // value. The CHECK lives on outcome_type and rejects anything
  // outside the 4-value reported_* set.
  const attemptId = await stageApproveAuthorizeClaimAttempt({ payloadHint: 'CHECK probe' });
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', ADMIN5_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'admin']);
    await assert.rejects(
      () => raw.query(
        `INSERT INTO governance_execution_outcomes
           (pilot_instance_id, execution_attempt_id, authorization_scope,
            execution_surface, outcome_type, recorded_by_user_id, recorded_by_role)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [PILOT_A, attemptId, 'memory_candidate_admission',
         'future_memory_admission_consumer', 'verified_completed',
         ADMIN5_A, 'admin']
      ),
      /check constraint|outcome_type/i
    );
    await raw.query('ROLLBACK');
  } finally {
    await raw.end();
  }
});

test('execution-outcome integration: listExecutionOutcomes returns rows visible to admin', async () => {
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const outcomes = await ctx.listExecutionOutcomes({ limit: 50 });
      assert.ok(outcomes.length >= 1, 'admin must see at least the seeded outcome');
      const fixtureSeed = outcomes.find((o) => o.id === 'aaaaaaaa-9999-1111-1111-e00000000001');
      assert.ok(fixtureSeed, 'seeded OUTCOME_A must appear');
      assert.equal(fixtureSeed.recorded_by_role, 'admin');
      assert.equal(fixtureSeed.outcome_type, 'reported_completed');
      assert.equal(fixtureSeed.authorization_scope, 'memory_candidate_admission');
      assert.equal(fixtureSeed.execution_surface, 'future_memory_admission_consumer');
    }
  );
});
