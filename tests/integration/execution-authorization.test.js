'use strict';
/*
 * Integration tests for the GM-25 execution-authorization substrate.
 *
 * Exercises the full chain end-to-end against a real Postgres:
 *   createExecutionAuthorizationActor
 *     → withReviewContext
 *       → recordExecutionAuthorization
 *         → lylo_app LOGIN role + RLS + BEFORE-INSERT trigger
 *           → governance_execution_authorizations
 *
 * Plus the G-series adversarial integration scenarios
 * (self-authorization trigger, rejected-review trigger, scope-
 * mismatch trigger, double-authorization UNIQUE, cross-pilot
 * composite-FK rejection, admin-only INSERT WITH CHECK,
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
  OUTCOMES,
} = require('../../src/actors');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const LYLO_APP_DATABASE_URL = process.env.LYLO_APP_DATABASE_URL;
const REPO = path.join(__dirname, '..', '..');

const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';
const SENIOR_A = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const FAMILY_A = 'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa';
const ADMIN_A = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const SENIOR_B = 'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb';

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
    const r = await su.query('SELECT COUNT(*)::int AS n FROM governance_execution_authorizations');
    return r.rows[0].n;
  } finally {
    await su.end();
  }
}

function authorizeDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
}

// stageAndApprove: helper that builds a fresh queue item, has an
// admin (different from the authorizer we'll use later) approve
// it, and returns the new review_decision_id. The authorizer in
// happy-path tests is always ADMIN2_A so we have authorizer !=
// reviewer naturally.
async function stageAndApprove({ proposerUserId, proposerRole, reviewerUserId, payloadHint }) {
  const stagingActor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  const staged = await stagingActor.execute(requires, {
    pilotInstanceId: PILOT_A,
    userId: proposerUserId,
    userRole: proposerRole,
    payloadSummary: { content: payloadHint, provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'integration' },
  });
  const reviewActor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decideDecision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  const reviewed = await reviewActor.execute(decideDecision, {
    pilotInstanceId: PILOT_A,
    userId: reviewerUserId,
    userRole: 'admin',
    reviewQueueId: staged.queueEntryId,
    reviewOutcome: 'approved',
    reviewReason: 'approved_admin_review',
  });
  return reviewed.reviewDecisionId;
}

// ---- happy path ----

test('execution-authorization integration: admin2 authorizes an admin1-approved review; row visible to admin', async () => {
  const reviewDecisionId = await stageAndApprove({
    proposerUserId: SENIOR_A,
    proposerRole: 'senior',
    reviewerUserId: ADMIN_A,
    payloadHint: 'happy-path candidate',
  });
  const before = await rowCount();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  const result = await actor.execute(decision, {
    pilotInstanceId: PILOT_A,
    userId: ADMIN2_A,
    userRole: 'admin',
    reviewDecisionId,
    authorizationScope: 'memory_candidate_admission',
    authorizationReason: 'admin_explicit_authorization',
  });
  assert.equal(result.outcome, OUTCOMES.AUTHORIZED_RECORDED);
  assert.match(result.authorizationId, /^[0-9a-f-]{36}$/);
  const after = await rowCount();
  assert.equal(after, before + 1, 'exactly one row recorded');

  // Admin sees the new authorization via the admin SELECT policy.
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const inspect = await ctx.inspectExecutionAuthorization(result.authorizationId);
      assert.ok(inspect, 'admin must see the authorization row');
      assert.equal(inspect.review_decision_id, reviewDecisionId);
      assert.equal(inspect.authorized_by_user_id, ADMIN2_A);
      assert.equal(inspect.authorization_scope, 'memory_candidate_admission');
    }
  );
});

test('execution-authorization integration: senior (proposer) cannot SELECT the authorization', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await raw.query('BEGIN');
    await raw.query('SELECT set_config($1, $2, true)', ['app.pilot_instance_id', PILOT_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_id', SENIOR_A]);
    await raw.query('SELECT set_config($1, $2, true)', ['app.user_role', 'senior']);
    const r = await raw.query('SELECT id FROM governance_execution_authorizations');
    assert.deepEqual(r.rows, [], 'senior must see no authorization rows');
    await raw.query('COMMIT');
  } finally {
    await raw.end();
  }
});

// ---- G-series counterparts ----

test('execution-authorization integration: self-authorization rejected by BEFORE-INSERT trigger', async () => {
  // admin-A reviewed; admin-A then tries to authorize the same row.
  const reviewDecisionId = await stageAndApprove({
    proposerUserId: SENIOR_A,
    proposerRole: 'senior',
    reviewerUserId: ADMIN_A,
    payloadHint: 'self-authorization attempt',
  });
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A,
      userId: ADMIN_A,
      userRole: 'admin',
      reviewDecisionId,
      authorizationScope: 'memory_candidate_admission',
      authorizationReason: 'admin_explicit_authorization',
    }),
    /self-authorization forbidden|review operation failed/i
  );
});

test('execution-authorization integration: authorizing a rejected review is rejected by trigger', async () => {
  // Stage + reject a review.
  const stagingActor = createReviewQueueActor({ reviewQueuePool: reviewPool });
  const requires = classifyExecutionIntent({
    type: INTENT_TYPES.MEMORY_CANDIDATE_CREATE,
    payload: { provenance: 'AI_INFERRED' },
  });
  const staged = await stagingActor.execute(requires, {
    pilotInstanceId: PILOT_A, userId: SENIOR_A, userRole: 'senior',
    payloadSummary: { content: 'will-be-rejected', provenance: 'AI_INFERRED' },
    evidenceSummary: { source: 'integration' },
  });
  const reviewActor = createReviewDecisionActor({ reviewQueuePool: reviewPool });
  const decideDecision = classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_REVIEW_DECIDE });
  const reviewed = await reviewActor.execute(decideDecision, {
    pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin',
    reviewQueueId: staged.queueEntryId,
    reviewOutcome: 'rejected', reviewReason: 'rejected_policy_violation',
  });
  // Now try to authorize the rejected review.
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
      reviewDecisionId: reviewed.reviewDecisionId,
      authorizationScope: 'memory_candidate_admission',
      authorizationReason: 'admin_explicit_authorization',
    }),
    /non-approved review|review_outcome|review operation failed/i
  );
});

test('execution-authorization integration: scope mismatch rejected by trigger', async () => {
  // Underlying intent is memory.candidate.create — authorize with
  // the wrong scope.
  const reviewDecisionId = await stageAndApprove({
    proposerUserId: SENIOR_A,
    proposerRole: 'senior',
    reviewerUserId: ADMIN_A,
    payloadHint: 'scope-mismatch attempt',
  });
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
      reviewDecisionId,
      authorizationScope: 'future_vault_action',
      authorizationReason: 'admin_explicit_authorization',
    }),
    /does not match intent type|review operation failed/i
  );
});

test('execution-authorization integration: duplicate authorization rejected (UNIQUE)', async () => {
  const reviewDecisionId = await stageAndApprove({
    proposerUserId: SENIOR_A,
    proposerRole: 'senior',
    reviewerUserId: ADMIN_A,
    payloadHint: 'double-authorization attempt',
  });
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  // First authorization succeeds.
  await actor.execute(decision, {
    pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
    reviewDecisionId,
    authorizationScope: 'memory_candidate_admission',
    authorizationReason: 'admin_explicit_authorization',
  });
  // Second fails UNIQUE.
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
      reviewDecisionId,
      authorizationScope: 'memory_candidate_admission',
      authorizationReason: 'admin_explicit_authorization',
    }),
    /duplicate key|unique|review operation failed/i
  );
});

test('execution-authorization integration: cross-pilot review_decision_id rejected', async () => {
  // Seed-fixture has a pilot-B decision; try to authorize it from pilot A.
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: reviewPool });
  const decision = authorizeDecision();
  await assert.rejects(
    () => actor.execute(decision, {
      pilotInstanceId: PILOT_A, userId: ADMIN2_A, userRole: 'admin',
      reviewDecisionId: 'bbbbbbbb-dddd-2222-2222-800000000002',
      authorizationScope: 'memory_candidate_admission',
      authorizationReason: 'admin_explicit_authorization',
    }),
    /row.level security|new row violates row.level|foreign key|review operation failed/i
  );
});

test('execution-authorization integration: lylo_app cannot UPDATE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query("UPDATE governance_execution_authorizations SET authorization_reason = 'admin_explicit_authorization'"),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-authorization integration: lylo_app cannot DELETE — GRANT denial', async () => {
  const raw = new Client({ connectionString: LYLO_APP_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('DELETE FROM governance_execution_authorizations'),
      /permission denied|append.only/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-authorization integration: lylo_runtime denied at GRANT layer', async () => {
  if (!LYLO_RUNTIME_DATABASE_URL) return;
  const raw = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await raw.connect();
  try {
    await assert.rejects(
      () => raw.query('SELECT id FROM governance_execution_authorizations'),
      /permission denied/i
    );
  } finally {
    await raw.end();
  }
});

test('execution-authorization integration: listExecutionAuthorizations returns rows visible to admin', async () => {
  await withReviewContext(
    reviewPool,
    { pilotInstanceId: PILOT_A, userId: ADMIN_A, userRole: 'admin' },
    async (ctx) => {
      const auths = await ctx.listExecutionAuthorizations({ limit: 50 });
      // Fixture-seeded AUTH_A plus any happy-path authorizations
      // recorded earlier in this run must all be visible.
      assert.ok(auths.length >= 1, 'admin must see at least the seeded authorization');
      const fixtureSeed = auths.find((a) => a.id === 'aaaaaaaa-cccc-1111-1111-900000000001');
      assert.ok(fixtureSeed, 'seeded AUTH_A must appear');
      assert.equal(fixtureSeed.authorized_by_role, 'admin');
    }
  );
});
