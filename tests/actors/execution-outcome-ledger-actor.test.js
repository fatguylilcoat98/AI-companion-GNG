'use strict';
/*
 * Unit tests for the GM-28 execution-outcome ledger actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_EXECUTION_OUTCOME_RECORD
 * intent type added in GM-28). The review queue pool is mocked —
 * no DB.
 *
 * Negative properties live in the dedicated adversarial suite at
 * tests/governance/adversarial.test.js (J-series, GM-28 additions).
 *
 * Constitutional invariant: AN OUTCOME ROW IS NOT TRUTH.
 * `reported_completed` ≠ `verified_completed`. The 4 outcome
 * vocabulary values are observational, not evaluative.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createExecutionOutcomeLedgerActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const ATTEMPT_ID = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'eeeeeeee-1111-1111-1111-eeeeeeeeeeee', created_at: new Date() }],
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

function outcomeDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      executionAttemptId: ATTEMPT_ID,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
      outcomeType: 'reported_completed',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createExecutionOutcomeLedgerActor: rejects missing options', () => {
  assert.throws(() => createExecutionOutcomeLedgerActor(), /options object is required/);
  assert.throws(() => createExecutionOutcomeLedgerActor(null), /options object is required/);
});

test('createExecutionOutcomeLedgerActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createExecutionOutcomeLedgerActor({}), /reviewQueuePool is required/);
});

test('createExecutionOutcomeLedgerActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.execution.outcome.record as admissible', () => {
  const d = outcomeDecision();
  assert.equal(d.intentType, 'governance.execution.outcome.record');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'execution_outcome_recording_permitted');
  assert.match(d.policyRef, /execution-outcome-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin outcome Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.OUTCOME_RECORDED);
  assert.equal(result.outcome, 'outcome_recorded');
  assert.equal(result.decision, decision);
  assert.match(result.outcomeId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_execution_outcomes/);
});

test('execute: accepts every value in the reported_* vocabulary', async () => {
  for (const outcomeType of [
    'reported_completed',
    'reported_interrupted',
    'reported_abandoned',
    'reported_unknown',
  ]) {
    const pool = makeMockReviewPool();
    const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
    const decision = outcomeDecision();
    const result = await actor.execute(decision, baseParams({ outcomeType }));
    assert.equal(result.outcome, OUTCOMES.OUTCOME_RECORDED);
  }
});

// ---- vocabulary validation ----

test('execute: rejects outcomeType outside locked reported_* vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  for (const bad of [
    'completed',         // missing reported_ prefix
    'succeeded',         // operational
    'failed',            // operational
    'reported_succeeded', // smuggled truth claim
    'reported_failed',    // smuggled truth claim
    'verified_completed', // verification is a separate ring
    '',
    'REPORTED_COMPLETED',
  ]) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ outcomeType: bad })),
      /outcomeType must be one of/,
      `outcomeType "${bad}" must be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects authorizationScope outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  for (const bad of ['arbitrary_action', 'memory', '']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ authorizationScope: bad })),
      /authorizationScope must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects executionSurface outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  for (const bad of ['arbitrary_consumer', '', 'memory_admission_consumer']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ executionSurface: bad })),
      /executionSurface must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID executionAttemptId / pilotInstanceId / userId', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ executionAttemptId: 'not-a-uuid' })),
    /executionAttemptId must be a UUID/
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
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool });
  const decision = outcomeDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary fields appear in logs; unknown-field sentinels do not', async () => {
  const SENTINEL = 'SENTINEL_OUTCOME_NOTES';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createExecutionOutcomeLedgerActor({ reviewQueuePool: pool, log });
  const decision = outcomeDecision();
  await actor.execute(
    decision,
    Object.assign(baseParams(), { recorderNotes: SENTINEL, payload: SENTINEL })
  );
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.execution_outcome.recorded'));
  assert.ok(text.includes('reported_completed'));
  assert.ok(text.includes('memory_candidate_admission'));
  assert.equal(text.includes(SENTINEL), false);
});
