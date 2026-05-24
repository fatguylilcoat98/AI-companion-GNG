'use strict';
/*
 * Integration tests for the GM-26 execution-claim substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createExecutionClaimLedgerActor
 *     → withReviewContext
 *       → recordExecutionClaim
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_execution_claims
 *
 * Plus the H-series adversarial integration scenarios
 * (self-claim trigger, replay UNIQUE, scope-drift trigger,
 * surface-mismatch trigger, cross-pilot composite-FK rejection,
 * append-only enforcement, GRANT denial for lylo_runtime).
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
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_execution_claims');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function claimDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
}

// Helper: stage → approve → authorize. Returns the new
// execution_authorization_id. The reviewer is ADMIN_A; the
// authorizer is ADMIN2_A (which satisfies authorizer ≠ reviewer).
// The claimant in tests is ADMIN3_A so claimant ≠ authorizer.
async function stageApproveAuthorize({ payloadHint }) {
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
  return authorized.authorizationId;
}

// ---- happy path ----

test('execution-claim integration: admin3 claims an admin2-authorized item; row visible to admin', async () => {
  const authId = await stageApproveAuthorize({ payloadHint: 'happy-path candidate' });
  const before = await rowCount();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN3_A,
    userRole: 'admin',
    executionAuthorizationId: authId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  assert.equal(result.outcome, OUTCOMES.CLAIM_RECORDED);
  assert.match(result.claimId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  // Admin sees the new claim via the admin SELECT policy.
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const inspect = await ctx.inspectExecutionClaim(result.claimId);
      assert.ok(inspect, 'admin must see the claim row');
      assert.equal(inspect.execution_authorization_id, authId);
      assert.equal(inspect.claimed_by_user_id, ADMIN3_A);
      assert.equal(inspect.authorization_scope, 'memory_candidate_admission');
      assert.equal(inspect.execution_surface, 'future_memory_admission_consumer');
    }
  );
});

test('execution-claim integration: senior (proposer) cannot SELECT the claim', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id FROM governance_execution_claims');
    assert.deepEqual(r.rows, [], 'senior must see no claim rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- H-series counterparts ----

test('execution-claim integration: self-claim rejected by BEFORE-INSERT trigger', async () => {
  // admin2 authorized; admin2 then tries to claim. The trigger raises.
  const authId = await stageApproveAuthorize({ payloadHint: 'self-claim attempt' });
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN2_A, // same human who authorized
      userRole: 'admin',
      executionAuthorizationId: authId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /self-claim forbidden|review operation failed/i
  );
});

test('execution-claim integration: replay (double claim) rejected (UNIQUE)', async () => {
  const authId = await stageApproveAuthorize({ payloadHint: 'replay attempt' });
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  // First claim succeeds.
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN3_A,
    userRole: 'admin',
    executionAuthorizationId: authId,
    authorizationScope: 'memory_candidate_admission',
    executionSurface: 'future_memory_admission_consumer',
  });
  // Second fails UNIQUE.
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN3_A,
      userRole: 'admin',
      executionAuthorizationId: authId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('execution-claim integration: scope drift rejected by trigger', async () => {
  // Authorization is memory_candidate_admission; claim says future_vault_action.
  const authId = await stageApproveAuthorize({ payloadHint: 'scope-drift attempt' });
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN3_A,
      userRole: 'admin',
      executionAuthorizationId: authId,
      authorizationScope: 'future_vault_action',
      executionSurface: 'future_vault_action_consumer',
    }),
    /authorization_scope drift|review operation failed/i
  );
});

test('execution-claim integration: surface mismatch rejected by trigger', async () => {
  // Authorization is memory_candidate_admission; claim's scope
  // matches but surface is wrong.
  const authId = await stageApproveAuthorize({ payloadHint: 'surface-mismatch attempt' });
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN3_A,
      userRole: 'admin',
      executionAuthorizationId: authId,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_vault_action_consumer',
    }),
    /does not fit authorization_scope|review operation failed/i
  );
});

test('execution-claim integration: cross-pilot execution_authorization_id rejected', async () => {
  // Fixture seeds a pilot-B authorization; try to claim it from pilot A.
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: reviewPool });
  const decision = claimDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN3_A,
      userRole: 'admin',
      executionAuthorizationId: 'bbbbbbbb-cccc-2222-2222-900000000001',
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed/i
  );
});

test('execution-claim integration: lylo_app cannot UPDATE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_execution_claims SET claimed_by_role = 'admin'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-claim integration: lylo_app cannot DELETE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_execution_claims'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-claim integration: lylo_runtime denied at GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_execution_claims'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-claim integration: listExecutionClaims returns rows visible to admin', async () => {
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const claims = await ctx.listExecutionClaims({ limit: 50 });
      // Fixture-seeded CLAIM_A plus any happy-path claims recorded
      // earlier in this run must all be visible.
      assert.ok(claims.length >= 1, 'admin must see at least the seeded claim');
      const fixtureSeed = claims.find((c) => c.id === 'aaaaaaaa-bbbb-1111-1111-a00000000001');
      assert.ok(fixtureSeed, 'seeded CLAIM_A must appear');
      assert.equal(fixtureSeed.claimed_by_role, 'admin');
      assert.equal(fixtureSeed.authorization_scope, 'memory_candidate_admission');
      assert.equal(fixtureSeed.execution_surface, 'future_memory_admission_consumer');
    }
  );
});
