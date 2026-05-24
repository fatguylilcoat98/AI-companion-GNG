'use strict';
/*
 * Unit tests for the GM-25 execution-authorization actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_EXECUTION_AUTHORIZE
 * intent type added in GM-25). The review queue pool is mocked —
 * no DB.
 *
 * Negative properties (forged Decisions, prototype tampering,
 * wrong-intent-type, non-admin role, sentinel leakage) live in the
 * dedicated adversarial suite at
 * tests/governance/adversarial.test.js (G-series, GM-25 additions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createExecutionAuthorizationActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const DECISION_ID = 'dddddddd-1111-1111-1111-dddddddddddd';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'cccccccc-1111-1111-1111-cccccccccccc', created_at: new Date() }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => {},
  };
  return {
    connect: async () => { connectCalls += 1; return client; },
    getConnectCalls: () => connectCalls,
    getQueries: () => queries,
  };
}

function makeCapturingLogger() {
  const lines = [];
  return {
    lines,
    info(event, fields) {
      lines.push(JSON.stringify({ ts: 'X', level: 'info', event, pid: 0, ...(fields || {}) }));
    },
    asJoinedText() { return lines.join('\n'); },
  };
}

function authorizeDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_AUTHORIZE });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      reviewDecisionId: DECISION_ID,
      authorizationScope: 'memory_candidate_admission',
      authorizationReason: 'admin_explicit_authorization',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createExecutionAuthorizationActor: rejects missing options', () => {
  assert.throws(() => createExecutionAuthorizationActor(), /options object is required/);
  assert.throws(() => createExecutionAuthorizationActor(null), /options object is required/);
});

test('createExecutionAuthorizationActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createExecutionAuthorizationActor({}), /reviewQueuePool is required/);
});

test('createExecutionAuthorizationActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.execution.authorize as admissible', () => {
  const d = authorizeDecision();
  assert.equal(d.intentType, 'governance.execution.authorize');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'execution_authorization_recording_permitted');
  assert.match(d.policyRef, /execution-authorization-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin authorize Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.AUTHORIZED_RECORDED);
  assert.equal(result.outcome, 'authorized_recorded');
  assert.equal(result.decision, decision);
  assert.match(result.authorizationId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_execution_authorizations/);
});

test('execute: a single Decision instance can be reused across authorizations of different review_decisions', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  const r1 = await actor.execute(decision, baseParams());
  const r2 = await actor.execute(decision, baseParams({
    reviewDecisionId: 'eeeeeeee-2222-2222-2222-eeeeeeeeeeee',
  }));
  assert.equal(r1.outcome, OUTCOMES.AUTHORIZED_RECORDED);
  assert.equal(r2.outcome, OUTCOMES.AUTHORIZED_RECORDED);
});

// ---- vocabulary validation ----

test('execute: rejects authorizationScope outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  for (const bad of ['arbitrary_action', 'memory', '', 'MEMORY_CANDIDATE_ADMISSION']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ authorizationScope: bad })),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects authorizationReason outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  for (const bad of ['because', 'admin_did_it', '', 'ADMIN_EXPLICIT_AUTHORIZATION']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ authorizationReason: bad })),
      /authorizationReason must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID reviewDecisionId / pilotInstanceId / userId', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ reviewDecisionId: 'not-a-uuid' })),
    /reviewDecisionId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, baseParams({ pilotInstanceId: 'x' })),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => actor.execute(decision, baseParams({ userId: 'y' })),
    /userId must be a UUID/
  );
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects missing params', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool });
  const decision = authorizeDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary fields appear in logs as typed metadata; no other content does', async () => {
  const SENTINEL = 'SENTINEL_NOTES_AAA';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createExecutionAuthorizationActor({ reviewQueuePool: pool, log });
  const decision = authorizeDecision();
  await actor.execute(
    decision,
    Object.assign(baseParams(), { authorizerNotes: SENTINEL, payload: SENTINEL })
  );
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.execution_authorization.recorded'));
  assert.ok(text.includes('memory_candidate_admission'));
  assert.ok(text.includes('admin_explicit_authorization'));
  // Unknown-field sentinel must not leak.
  assert.equal(text.includes(SENTINEL), false);
});
