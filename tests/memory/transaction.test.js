'use strict';
/*
 * Unit tests for withMemoryContext. The pool is mocked — no real DB.
 * These tests check the transaction-discipline contract:
 *   - validation throws before any DB work
 *   - BEGIN + 3 set_config calls + fn + COMMIT in that order
 *   - ROLLBACK on any throw inside fn
 *   - client.release() runs on every path
 *   - ctx exposes the bundled ops, NOT the raw client
 *   - GM-18: pg errors thrown inside fn are wrapped into
 *     MemoryRepositoryError; caller-contract validation errors are
 *     passed through unchanged
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { withMemoryContext } = require('../../src/memory/transaction');
const { MemoryRepositoryError } = require('../../src/memory/errors');

const PILOT = '11111111-1111-1111-1111-111111111111';
const USER = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';

function makeFakeClient(overrides) {
  const queries = [];
  let released = false;
  const queryImpl = (overrides && overrides.query) || (async (text, params) => {
    queries.push({ text, params: params || [] });
    return { rows: [], rowCount: 0 };
  });
  return {
    queries,
    isReleased: () => released,
    query: async (text, params) => {
      const r = await queryImpl(text, params);
      // The default impl records — pass-through impls (overrides)
      // record themselves if they want.
      return r;
    },
    release: () => {
      released = true;
    },
  };
}

function makeFakePool(client) {
  return {
    connect: async () => client,
  };
}

test('withMemoryContext: rejects a missing pool with a MemoryPoolHandle message', async () => {
  await assert.rejects(
    () => withMemoryContext(null, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, async () => {}),
    /pool must be a MemoryPoolHandle/
  );
});

test('withMemoryContext: rejects a non-function callback', async () => {
  const pool = makeFakePool(makeFakeClient());
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' }, null),
    /callback function is required/
  );
});

test('withMemoryContext: rejects a non-UUID pilotInstanceId before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: 'not-a-uuid', userId: USER, userRole: 'senior' }, async () => {}),
    /pilotInstanceId must be a UUID/
  );
  assert.equal(client.queries.length, 0, 'no DB query must have been issued');
});

test('withMemoryContext: rejects a non-UUID userId before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: 'not-a-uuid', userRole: 'senior' }, async () => {}),
    /userId must be a UUID/
  );
  assert.equal(client.queries.length, 0);
});

test('withMemoryContext: rejects an unknown userRole before any DB work', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: 'godmode' }, async () => {}),
    /userRole must be one of/
  );
  assert.equal(client.queries.length, 0);
});

test('withMemoryContext: rejects a blank pilotInstanceId / userId / userRole', async () => {
  const pool = makeFakePool(makeFakeClient());
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: '', userId: USER, userRole: 'senior' }, async () => {}),
    /pilotInstanceId must be a UUID/
  );
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: '', userRole: 'senior' }, async () => {}),
    /userId must be a UUID/
  );
  await assert.rejects(
    () => withMemoryContext(pool, { pilotInstanceId: PILOT, userId: USER, userRole: '' }, async () => {}),
    /userRole must be one of/
  );
});

test('withMemoryContext: BEGIN, three set_config bindings, fn, COMMIT — in that order', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  let fnRan = false;

  await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async (ctx) => {
      fnRan = true;
      assert.equal(ctx.pilotInstanceId, PILOT);
      assert.equal(ctx.userId, USER);
      assert.equal(ctx.userRole, 'senior');
      // The ctx exposes the bundled ops only — never the raw client.
      assert.equal(typeof ctx.listVisibleMemories, 'function');
      assert.equal(typeof ctx.insertPrivateMemory, 'function');
      assert.equal(ctx.query, undefined, 'ctx must not expose raw client.query');
      assert.equal(ctx.client, undefined, 'ctx must not expose the raw client');
    }
  );

  assert.equal(fnRan, true);
  assert.equal(client.isReleased(), true, 'client must be released back to the pool');

  const texts = client.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'COMMIT',
  ]);

  const sets = client.queries.slice(1, 4);
  assert.deepEqual(sets[0].params, ['app.pilot_instance_id', PILOT]);
  assert.deepEqual(sets[1].params, ['app.user_id', USER]);
  assert.deepEqual(sets[2].params, ['app.user_role', 'senior']);
});

test('withMemoryContext: ROLLBACK on any throw inside fn; client still released', async () => {
  const client = makeFakeClient();
  const pool = makeFakePool(client);

  await assert.rejects(
    () =>
      withMemoryContext(
        pool,
        { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
        async () => {
          throw new Error('boom');
        }
      ),
    /boom/
  );

  const texts = client.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'SELECT set_config($1, $2, true)',
    'ROLLBACK',
  ]);
  assert.equal(client.isReleased(), true, 'client must be released even after a throw');
});

test('withMemoryContext: set_config is parameterized, not interpolated', async () => {
  // Defends against a regression where someone "simplifies" the
  // session-var binding into a raw SET LOCAL statement and reintroduces
  // SQL injection.
  const client = makeFakeClient();
  const pool = makeFakePool(client);
  await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async () => {}
  );
  for (const q of client.queries.slice(1, 4)) {
    assert.equal(q.text, 'SELECT set_config($1, $2, true)');
    assert.equal(q.params.length, 2);
  }
});

test('withMemoryContext: returns the fn result', async () => {
  const pool = makeFakePool(makeFakeClient());
  const result = await withMemoryContext(
    pool,
    { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
    async () => 42
  );
  assert.equal(result, 42);
});

// ---- GM-18: opaque handle ----

test('GM-18: createMemoryPool returns an opaque handle — no .connect / no .query / no .end / non-extensible', () => {
  const { createMemoryPool } = require('../../src/memory/client');
  const handle = createMemoryPool('postgres://example/db');
  try {
    assert.equal(handle.connect, undefined, 'handle must not expose .connect');
    assert.equal(handle.query, undefined, 'handle must not expose .query');
    assert.equal(handle.end, undefined, 'handle must not expose .end');
    assert.equal(Object.isFrozen(handle), true, 'handle must be frozen');
    // Can't monkey-patch a .connect onto it.
    assert.throws(() => {
      handle.connect = async () => ({});
    });
    assert.equal(handle.connect, undefined, 'monkey-patch must not stick');
    // Enumerable surface is empty.
    assert.deepEqual(Object.keys(handle), []);
  } finally {
    // No await: we don't need to actually close (no real pool started).
  }
});

test('GM-18: passing a non-handle non-mock to withMemoryContext fails with the MemoryPoolHandle message', async () => {
  await assert.rejects(
    () =>
      withMemoryContext(
        { foo: 'bar' }, // no .connect, not a MemoryPoolHandle
        { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
        async () => {}
      ),
    /pool must be a MemoryPoolHandle/
  );
});

test('GM-18: a real handle from createMemoryPool resolves through withMemoryContext via the WeakMap', async () => {
  // This test uses createMemoryPool to obtain a handle, then verifies
  // that withMemoryContext accepts it. The pool will fail to connect
  // (no real DB), and that error will be wrapped into a
  // MemoryRepositoryError — but the test's point is that
  // _resolvePool unwrapped the handle without throwing the
  // "must be a MemoryPoolHandle" guard.
  const { createMemoryPool, closeMemoryPool } = require('../../src/memory/client');
  const handle = createMemoryPool('postgres://127.0.0.1:1/nonexistent', {
    connectionTimeoutMillis: 50,
  });
  try {
    await assert.rejects(
      () =>
        withMemoryContext(
          handle,
          { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
          async () => {}
        ),
      // Failure originates from pool.connect — never from "must be a
      // MemoryPoolHandle" — proving the WeakMap lookup succeeded.
      (err) => !/must be a MemoryPoolHandle/.test(err.message)
    );
  } finally {
    await closeMemoryPool(handle);
  }
});

// ---- GM-18: error sanitization ----

test('GM-18: a pg-shaped error from inside fn(ctx) is wrapped into MemoryRepositoryError', async () => {
  // Simulate a pg error (5-char SQLSTATE in .code) thrown by the
  // caller's fn. withMemoryContext must wrap it so callers never see
  // pg.detail / pg.where / pg.routine.
  const client = {
    queries: [],
    query: async (text) => {
      if (text === 'BEGIN' || text.startsWith('SELECT set_config')) {
        return { rows: [], rowCount: 0 };
      }
      if (text === 'ROLLBACK' || text === 'COMMIT') {
        return { rows: [], rowCount: 0 };
      }
      // Anything else thrown as a pg error.
      const err = new Error('duplicate key value violates unique constraint');
      err.code = '23505';
      err.detail = 'Key (content)=(SECRET MEMORY) already exists.';
      err.where = 'PL/pgSQL function...';
      err.routine = '_bt_check_unique';
      throw err;
    },
    release: () => {},
  };
  const pool = { connect: async () => client };

  let caught;
  try {
    await withMemoryContext(
      pool,
      { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
      async (ctx) => {
        await ctx.insertPrivateMemory({ content: 'x', provenance: 'USER_STATED' });
      }
    );
  } catch (err) {
    caught = err;
  }

  assert.ok(caught, 'must have caught the wrapped error');
  assert.ok(caught instanceof MemoryRepositoryError, 'must be a MemoryRepositoryError');
  assert.equal(caught.name, 'MemoryRepositoryError');
  assert.equal(caught.error_class, '23505');
  assert.equal(caught.message, 'memory operation failed');
  // The sensitive pg internals must NOT have leaked onto the wrapper.
  assert.equal(caught.detail, undefined);
  assert.equal(caught.where, undefined);
  assert.equal(caught.routine, undefined);
  // And the serialized form must not echo the content.
  const serialized = JSON.stringify({
    name: caught.name,
    message: caught.message,
    error_class: caught.error_class,
  });
  assert.equal(serialized.includes('SECRET MEMORY'), false);
});

test('GM-18: a caller-contract validation error from inside fn(ctx) passes through unchanged', async () => {
  // insertPrivateMemory's own validation throws a plain Error with no
  // .code SQLSTATE. The wrapper must NOT touch it.
  const client = {
    queries: [],
    query: async () => ({ rows: [], rowCount: 0 }),
    release: () => {},
  };
  const pool = { connect: async () => client };

  await assert.rejects(
    () =>
      withMemoryContext(
        pool,
        { pilotInstanceId: PILOT, userId: USER, userRole: 'senior' },
        async (ctx) => {
          await ctx.insertPrivateMemory({ content: '', provenance: 'USER_STATED' });
        }
      ),
    (err) => {
      // Passes through as a plain Error with the descriptive message.
      return (
        err.name === 'Error'
        && /content must be a non-empty string/.test(err.message)
        && !(err instanceof MemoryRepositoryError)
      );
    }
  );
});
