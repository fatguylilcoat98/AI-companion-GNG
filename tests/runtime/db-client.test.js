'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  connectWithRetry,
  pingDatabase,
  describeDbError,
} = require('../../src/db/client');

// Fast backoff so the tests do not sleep on real schedules.
const fastDelays = [1, 1, 1, 1];

test('connectWithRetry: succeeds on the first attempt', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 1);
});

test('connectWithRetry: exhausts all attempts when the database is unreachable', async () => {
  const pool = {
    query: async () => {
      throw new Error('unreachable');
    },
  };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, false);
  assert.equal(r.attempts, 4);
});

test('connectWithRetry: recovers on a later attempt', async () => {
  let calls = 0;
  const pool = {
    query: async () => {
      calls += 1;
      if (calls < 3) throw new Error('not yet');
      return { rows: [] };
    },
  };
  const r = await connectWithRetry(pool, { delaysMs: fastDelays });
  assert.equal(r.connected, true);
  assert.equal(r.attempts, 3);
});

test('pingDatabase: true when reachable, false when not', async () => {
  assert.equal(await pingDatabase({ query: async () => ({ rows: [] }) }), true);
  assert.equal(
    await pingDatabase({
      query: async () => {
        throw new Error('down');
      },
    }),
    false
  );
});

test('describeDbError: reduces an error to a coarse, non-sensitive class', () => {
  assert.equal(describeDbError({ code: 'ECONNREFUSED' }), 'ECONNREFUSED');
  assert.equal(describeDbError({ name: 'TypeError' }), 'TypeError');
  assert.equal(describeDbError(null), 'unknown');
});

test("createPool: pool 'error' events are caught and logged with a coarse class", async () => {
  const { createPool } = require('../../src/db/client');
  const logs = [];
  const pool = createPool('postgres://x:x@127.0.0.1:1/x', { log: (m) => logs.push(m) });
  // Synthetic emit — a real transient backend error would surface the
  // same way. Without the handler, this would crash the process.
  pool.emit('error', Object.assign(new Error('synthetic'), { code: 'ECONNRESET' }));
  assert.ok(
    logs.some((m) => m.includes('ECONNRESET') && m.toLowerCase().includes('pool error')),
    `expected a pool-error log with the coarse class, got: ${logs.join(' | ')}`
  );
  await pool.end();
});
