'use strict';
/*
 * Unit tests for the GM-29 execution-verification ledger actor.
 *
 * Real GM-21 classifier produces Decisions (so the WeakSet-blessed
 * contract is exercised via the new GOVERNANCE_EXECUTION_VERIFY
 * intent type added in GM-29). The review queue pool is mocked —
 * no DB.
 *
 * Negative properties live in the dedicated adversarial suite at
 * tests/governance/adversarial.test.js (K-series).
 *
 * Constitutional invariant: VERIFICATION ≠ RECONCILIATION ≠ REPAIR.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../../src/governance');
const {
  createExecutionVerificationLedgerActor,
  OUTCOMES,
} = require('../../src/actors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const ADMIN = 'aaaaaaaa-9999-1111-1111-aaaaaaaaaaaa';
const OUTCOME_ID = 'aaaaaaaa-9999-1111-1111-e00000000001';

function makeMockReviewPool() {
  let connectCalls = 0;
  const queries = [];
  const client = {
    queries,
    async query(text) {
      queries.push(text);
      if (/RETURNING/i.test(text)) {
        return {
          rows: [{ id: 'ffffffff-1111-1111-1111-ffffffffffff', created_at: new Date() }],
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

function verifyDecision() {
  return classifyExecutionIntent({ type: INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY });
}

function baseParams(overrides) {
  return Object.assign(
    {
      pilotInstanceId: PILOT,
      userId: ADMIN,
      userRole: 'admin',
      executionOutcomeId: OUTCOME_ID,
      verificationType: 'human_observation',
      verificationResult: 'verified_consistent',
    },
    overrides || {}
  );
}

// ---- factory validation ----

test('createExecutionVerificationLedgerActor: rejects missing options', () => {
  assert.throws(() => createExecutionVerificationLedgerActor(), /options object is required/);
  assert.throws(() => createExecutionVerificationLedgerActor(null), /options object is required/);
});

test('createExecutionVerificationLedgerActor: rejects missing reviewQueuePool', () => {
  assert.throws(() => createExecutionVerificationLedgerActor({}), /reviewQueuePool is required/);
});

test('createExecutionVerificationLedgerActor: returns a frozen actor exposing only execute', () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  assert.equal(Object.isFrozen(actor), true);
  assert.equal(typeof actor.execute, 'function');
  assert.deepEqual(Object.keys(actor), ['execute']);
});

// ---- classifier integration ----

test('classifier admits governance.execution.verify as admissible', () => {
  const d = verifyDecision();
  assert.equal(d.intentType, 'governance.execution.verify');
  assert.equal(d.decision, 'admissible');
  assert.equal(d.reason, 'execution_verification_recording_permitted');
  assert.match(d.policyRef, /execution-verification-runtime-boundary/);
});

// ---- happy path ----

test('execute: records exactly one row on a valid admin verification Decision', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  const result = await actor.execute(decision, baseParams());
  assert.equal(result.outcome, OUTCOMES.VERIFICATION_RECORDED);
  assert.equal(result.outcome, 'verification_recorded');
  assert.equal(result.decision, decision);
  assert.match(result.verificationId, /^[0-9a-f-]{36}$/);
  assert.ok(result.createdAt instanceof Date);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(pool.getConnectCalls(), 1);
  // BEGIN + 3x set_config + INSERT + COMMIT = 6 queries.
  assert.equal(pool.getQueries().length, 6);
  const inserts = pool.getQueries().filter((q) => /^INSERT/i.test(q));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0], /INTO governance_execution_verifications/);
});

test('execute: accepts every combination of verification_type x verification_result', async () => {
  const types = ['human_observation', 'system_log_review', 'database_state_check', 'external_confirmation'];
  const results = ['verified_consistent', 'verified_inconsistent', 'verification_inconclusive'];
  for (const verificationType of types) {
    for (const verificationResult of results) {
      const pool = makeMockReviewPool();
      const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
      const decision = verifyDecision();
      const result = await actor.execute(decision, baseParams({ verificationType, verificationResult }));
      assert.equal(result.outcome, OUTCOMES.VERIFICATION_RECORDED);
    }
  }
});

// ---- vocabulary validation ----

test('execute: rejects verificationType outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  for (const bad of [
    'automated_check',          // automation as verifier is a separate decision
    'observation',              // missing channel qualifier
    'log_review',               // missing system_ prefix
    'check',                    // too generic
    '',
    'HUMAN_OBSERVATION',        // uppercase
  ]) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ verificationType: bad })),
      /verificationType must be one of/,
      `verificationType "${bad}" must be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects verificationResult outside locked vocabulary', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  for (const bad of [
    'verified_succeeded',       // truth-claim smuggle
    'verified_failed',          // truth-claim smuggle
    'verified_completed',       // smuggle from outcome vocab
    'reported_completed',       // wrong substrate vocab
    'verification_refused',     // explicitly excluded per OQ-29.4
    'consistent',               // missing verified_ prefix
    '',
    'VERIFIED_CONSISTENT',      // uppercase
  ]) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ verificationResult: bad })),
      /verificationResult must be one of/,
      `verificationResult "${bad}" must be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects non-UUID executionOutcomeId / pilotInstanceId / userId', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  await assert.rejects(
    () => actor.execute(decision, baseParams({ executionOutcomeId: 'not-a-uuid' })),
    /executionOutcomeId must be a UUID/
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

test('execute: rejects non-admin role', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  for (const bad of ['senior', 'family', 'caregiver', 'system', 'verifier', '']) {
    await assert.rejects(
      () => actor.execute(decision, baseParams({ userRole: bad })),
      /userRole must be "admin"/,
      `userRole "${bad}" must be rejected`
    );
  }
  assert.equal(pool.getConnectCalls(), 0);
});

test('execute: rejects missing params', async () => {
  const pool = makeMockReviewPool();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool });
  const decision = verifyDecision();
  await assert.rejects(() => actor.execute(decision), /params object is required/);
  assert.equal(pool.getConnectCalls(), 0);
});

// ---- sentinel content ----

test('execute: locked-vocabulary fields appear in logs; unknown-field sentinels do not', async () => {
  const SENTINEL = 'SENTINEL_VERIFICATION_BASIS';
  const pool = makeMockReviewPool();
  const log = makeCapturingLogger();
  const actor = createExecutionVerificationLedgerActor({ reviewQueuePool: pool, log });
  const decision = verifyDecision();
  await actor.execute(
    decision,
    Object.assign(baseParams(), { verificationBasis: SENTINEL, payload: SENTINEL, notes: SENTINEL })
  );
  const text = log.asJoinedText();
  assert.ok(text.includes('actor.execution_verification.recorded'));
  assert.ok(text.includes('verified_consistent'));
  assert.ok(text.includes('human_observation'));
  assert.equal(text.includes(SENTINEL), false);
});
