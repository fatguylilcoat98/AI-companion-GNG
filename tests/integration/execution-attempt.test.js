'use strict';
/*
 * Integration tests for the GM-27 execution-attempt substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createExecutionAttemptLedgerActor
 *     → withReviewContext
 *       → recordExecutionAttempt
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_execution_attempts
 *
 * Plus the I-series adversarial integration scenarios
 * (self-attempt trigger, replay UNIQUE, scope-drift trigger,
 * surface-drift trigger, cross-pilot composite-FK rejection,
 * append-only enforcement, GRANT denial for lylo_runtime).
 *
 * Constitutional rule: ATTEMPT IS NOT OUTCOME.
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
  OUTCOMES,
} = require('../../src/actors');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const ADMIN4_A = 'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa';

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
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_execution_attempts');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function attemptDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
}

// Helper: stage → approve → authorize → claim. Returns the new
// execution_claim_id. Reviewer = ADMIN_A; authorizer = ADMIN2_A;
// claimant = ADMIN3_A. The attempter in tests is ADMIN4_A so
// attempter ≠ claimant naturally.
async function stageApproveAuthorizeClaim({ payloadHint }) {
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
  return claimed.claimId;
}

// ---- happy path ----

test('execution-attempt integration: admin4 records an attempt against an admin3-claimed item; row visible to admin', async () => {
  const claimId = await stageApproveAuthorizeClaim({ payloadHint: 'happy-path candidate' });
  const before = await rowCount();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN4_A,
    userRole: 'admin',
    executionClaimId: claimId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  assert.equal(result.outcome, OUTCOMES.ATTEMPT_RECORDED);
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  // Admin sees the new attempt via the admin SELECT policy.
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const inspect = await ctx.inspectExecutionAttempt(result.attemptId);
      assert.ok(inspect, 'admin must see the attempt row');
      assert.equal(inspect.execution_claim_id, claimId);
      assert.equal(inspect.attempted_by_user_id, ADMIN4_A);
      assert.equal(inspect.authorization_scope, 'memory_candidate_admission');
      assert.equal(inspect.execution_surface, 'future_memory_admission_consumer');
    }
  );
});

test('execution-attempt integration: senior (proposer) cannot SELECT the attempt', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id FROM governance_execution_attempts');
    assert.deepEqual(r.rows, [], 'senior must see no attempt rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- I-series counterparts ----

test('execution-attempt integration: self-attempt rejected by BEFORE-INSERT trigger', async () => {
  // admin3 claimed; admin3 then tries to attempt against the same claim.
  const claimId = await stageApproveAuthorizeClaim({ payloadHint: 'self-attempt attempt' });
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN3_A, // same human who claimed
      userRole: 'admin',
      executionClaimId: claimId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /self-attempt forbidden|review operation failed/i
  );
});

test('execution-attempt integration: replay (double attempt) rejected (UNIQUE)', async () => {
  const claimId = await stageApproveAuthorizeClaim({ payloadHint: 'replay attempt' });
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  // First attempt succeeds.
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN4_A,
    userRole: 'admin',
    executionClaimId: claimId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  // Second fails UNIQUE.
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN4_A,
      userRole: 'admin',
      executionClaimId: claimId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('execution-attempt integration: scope drift rejected by trigger', async () => {
  // Claim's scope is memory_candidate_admission; attempt declares future_vault_action.
  const claimId = await stageApproveAuthorizeClaim({ payloadHint: 'scope-drift attempt' });
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN4_A,
      userRole: 'admin',
      executionClaimId: claimId,
      authorizationScope: 'future_vault_action',
      executionSurface: 'future_vault_action_consumer',
    }),
    /authorization_scope drift|review operation failed/i
  );
});

test('execution-attempt integration: surface drift rejected by trigger', async () => {
  // Claim's surface is future_memory_admission_consumer; attempt
  // declares future_vault_action_consumer (matching scope but
  // wrong surface — the trigger asserts surface equality with the
  // claim independently of the scope ↔ surface mapping).
  const claimId = await stageApproveAuthorizeClaim({ payloadHint: 'surface-drift attempt' });
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN4_A,
      userRole: 'admin',
      executionClaimId: claimId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_vault_action_consumer',
    }),
    /execution_surface drift|review operation failed/i
  );
});

test('execution-attempt integration: cross-pilot execution_claim_id rejected', async () => {
  // Fixture seeds a pilot-B claim; try to attempt against it from pilot A.
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: reviewPool });
  const decision = attemptDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN4_A,
      userRole: 'admin',
      executionClaimId: 'bbbbbbbb-bbbb-2222-2222-b00000000001',
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed/i
  );
});

test('execution-attempt integration: lylo_app cannot UPDATE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_execution_attempts SET attempted_by_role = 'admin'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-attempt integration: lylo_app cannot DELETE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_execution_attempts'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-attempt integration: lylo_runtime denied at GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_execution_attempts'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-attempt integration: listExecutionAttempts returns rows visible to admin', async () => {
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const attempts = await ctx.listExecutionAttempts({ limit: 50 });
      assert.ok(attempts.length >= 1, 'admin must see at least the seeded attempt');
      const fixtureSeed = attempts.find((a) => a.id === 'aaaaaaaa-aaaa-1111-1111-c00000000001');
      assert.ok(fixtureSeed, 'seeded ATTEMPT_A must appear');
      assert.equal(fixtureSeed.attempted_by_role, 'admin');
      assert.equal(fixtureSeed.authorization_scope, 'memory_candidate_admission');
      assert.equal(fixtureSeed.execution_surface, 'future_memory_admission_consumer');
    }
  );
});
