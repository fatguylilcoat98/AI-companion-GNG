'use strict';
/*
 * Unit tests for the GM-27 execution-attempt ledger actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_EXECUTION_ATTEMPT
 * intent type added in GM-27). The review queue pool is mocked —
 * no DB.
 *
 * Negative properties live in the dedicated adversarial suite at
 * tests/governance/adversarial.test.js (I-series, GM-27 additions).
 *
 * Constitutional invariant: ATTEMPT IS NOT OUTCOME. An attempt
 * row records ONLY the beginning of an attempt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createExecutionAttemptLedgerActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const CLAIM_ID = 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', created_at: new Date() }],
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

function attemptDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_ATTEMPT });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      executionClaimId: CLAIM_ID,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createExecutionAttemptLedgerActor: rejects missing options', () => {
  assert.throws(() => createExecutionAttemptLedgerActor(), /options object is required/);
  assert.throws(() => createExecutionAttemptLedgerActor(null), /options object is required/);
});

test('createExecutionAttemptLedgerActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createExecutionAttemptLedgerActor({}), /reviewQueuePool is required/);
});

test('createExecutionAttemptLedgerActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.execution.attempt as admissible', () => {
  const d = attemptDecision();
  assert.equal(d.intentType, 'governance.execution.attempt');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'execution_attempt_recording_permitted');
  assert.match(d.policyRef, /execution-attempt-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin attempt Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.ATTEMPT_RECORDED);
  assert.equal(result.outcome, 'attempt_recorded');
  assert.equal(result.decision, decision);
  assert.match(result.attemptId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_execution_attempts/);
});

test('execute: a single Decision instance can be reused across attempts of different claims', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  const r1 = await actor.execute(decision, baseParams());
  const r2 = await actor.execute(decision, baseParams({
    executionClaimId: 'cccccccc-2222-2222-2222-cccccccccccc',
  }));
  assert.equal(r1.outcome, OUTCOMES.ATTEMPT_RECORDED);
  assert.equal(r2.outcome, OUTCOMES.ATTEMPT_RECORDED);
});

// ---- vocabulary validation ----

test('execute: rejects authorizationScope outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  for (const bad of ['arbitrary_action', 'memory', '', 'MEMORY_CANDIDATE_ADMISSION']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ authorizationScope: bad })),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects executionSurface outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  for (const bad of ['arbitrary_consumer', '', 'memory_admission_consumer']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ executionSurface: bad })),
      /executionSurface must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID executionClaimId / pilotInstanceId / userId', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ executionClaimId: 'not-a-uuid' })),
    /executionClaimId must be a UUID/
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
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool });
  const decision = attemptDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary fields appear in logs; unknown-field sentinels do not', async () => {
  const SENTINEL = 'SENTINEL_ATTEMPT_NOTES';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createExecutionAttemptLedgerActor({ reviewQueuePool: pool, log });
  const decision = attemptDecision();
  await actor.execute(
    decision,
    Object.assign(baseParams(), { attempterNotes: SENTINEL, payload: SENTINEL })
  );
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.execution_attempt.recorded'));
  assert.ok(text.includes('memory_candidate_admission'));
  assert.ok(text.includes('future_memory_admission_consumer'));
  assert.equal(text.includes(SENTINEL), false);
});
