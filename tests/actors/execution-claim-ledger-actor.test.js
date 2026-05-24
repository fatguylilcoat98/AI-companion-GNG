'use strict';
/*
 * Unit tests for the GM-26 execution-claim ledger actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_EXECUTION_CLAIM
 * intent type added in GM-26). The review queue pool is mocked —
 * no DB.
 *
 * Negative properties live in the dedicated adversarial suite at
 * tests/governance/adversarial.test.js (H-series, GM-26 additions).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createExecutionClaimLedgerActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';
const AUTH_ID = 'cccccccc-1111-1111-1111-cccccccccccc';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'bbbbbbbb-1111-1111-1111-bbbbbbbbbbbb', created_at: new Date() }],
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

function claimDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_CLAIM });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      executionAuthorizationId: AUTH_ID,
      authorizationScope: 'memory_candidate_admission',
      executionSurface: 'future_memory_admission_consumer',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createExecutionClaimLedgerActor: rejects missing options', () => {
  assert.throws(() => createExecutionClaimLedgerActor(), /options object is required/);
  assert.throws(() => createExecutionClaimLedgerActor(null), /options object is required/);
});

test('createExecutionClaimLedgerActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createExecutionClaimLedgerActor({}), /reviewQueuePool is required/);
});

test('createExecutionClaimLedgerActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.execution.claim as admissible', () => {
  const d = claimDecision();
  assert.equal(d.intentType, 'governance.execution.claim');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'execution_claim_recording_permitted');
  assert.match(d.policyRef, /execution-claim-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin claim Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.CLAIM_RECORDED);
  assert.equal(result.outcome, 'claim_recorded');
  assert.equal(result.decision, decision);
  assert.match(result.claimId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_execution_claims/);
});

test('execute: a single Decision instance can be reused across claims of different authorizations', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
  const r1 = await actor.execute(decision, baseParams());
  const r2 = await actor.execute(decision, baseParams({
    executionAuthorizationId: 'dddddddd-2222-2222-2222-dddddddddddd',
  }));
  assert.equal(r1.outcome, OUTCOMES.CLAIM_RECORDED);
  assert.equal(r2.outcome, OUTCOMES.CLAIM_RECORDED);
});

// ---- vocabulary validation ----

test('execute: rejects authorizationScope outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
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
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
  for (const bad of ['arbitrary_consumer', 'memory_admission_consumer', '', 'FUTURE_MEMORY_ADMISSION_CONSUMER']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ executionSurface: bad })),
      /executionSurface must be one of/
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID executionAuthorizationId / pilotInstanceId / userId', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ executionAuthorizationId: 'not-a-uuid' })),
    /executionAuthorizationId must be a UUID/
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
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool });
  const decision = claimDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary fields appear in logs; unknown-field sentinels do not', async () => {
  const SENTINEL = 'SENTINEL_CLAIM_NOTES';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createExecutionClaimLedgerActor({ reviewQueuePool: pool, log });
  const decision = claimDecision();
  await actor.execute(
    decision,
    Object.assign(baseParams(), { claimerNotes: SENTINEL, payload: SENTINEL })
  );
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.execution_claim.recorded'));
  assert.ok(text.includes('memory_candidate_admission'));
  assert.ok(text.includes('future_memory_admission_consumer'));
  assert.equal(text.includes(SENTINEL), false);
});
