'use strict';

/*
 * RLS / privacy contract — real-schema proof.
 *
 * The synthetic suite (run-contract.js) validates the policies against
 * a generic schema. This file runs the same matrix against the REAL
 * db/migrations/ schema after applying 007_rls_policies.sql. If the
 * real-schema migrations diverge from the synthetic contract — a new
 * table without a policy, a column rename that breaks a policy, an
 * accidentally-disabled RLS — the matrix fails.
 *
 * Bootstrapping:
 *   1. DROP / CREATE the public schema.
 *   2. Apply db/migrations/0*.sql in number order — this includes the
 *      new 007_rls_policies.sql that creates roles, enables RLS, and
 *      installs the policies.
 *   3. Apply tests/rls-contract/fixtures.sql as the bootstrap
 *      superuser (which BYPASSes RLS), seeding the two-pilot data.
 *      The synthetic fixture INSERTs use named columns only; the real
 *      schema's additional columns (created_at, updated_at, etc.) take
 *      their defaults.
 *   4. Run the same visibility / write / default-deny matrix as the
 *      synthetic runner, but against rows in the real schema.
 *
 * Requires DATABASE_URL pointing at a Postgres 16 service container.
 * The runner DROPS and recreates the public schema; it must never be
 * pointed at a real instance database.
 */

const test = require('node:test');
const before = test.before;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const DIR = __dirname;
const REAL_MIGRATIONS_DIR = path.join(DIR, '..', '..', 'db', 'migrations');

// Identifiers from fixtures.sql.
const PILOT_A = '11111111-1111-1111-1111-111111111111';
const PILOT_B = '22222222-2222-2222-2222-222222222222';

const SENIOR_A    = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa';
const FAMILY_A    = 'aaaaaaaa-2222-1111-1111-aaaaaaaaaaaa';
const CAREGIVER_A = 'aaaaaaaa-3333-1111-1111-aaaaaaaaaaaa';
const ADMIN_A     = 'aaaaaaaa-4444-1111-1111-aaaaaaaaaaaa';

const SENIOR_B    = 'bbbbbbbb-1111-2222-2222-bbbbbbbbbbbb';

const MEM_A_PRIVATE         = 'aaaaaaaa-cccc-1111-1111-100000000001';
const MEM_A_FAMILY_SHARED   = 'aaaaaaaa-cccc-1111-1111-100000000002';
const MEM_A_PASSWORD_LOCKED = 'aaaaaaaa-cccc-1111-1111-100000000003';
const MEM_A_INADMISSIBLE    = 'aaaaaaaa-cccc-1111-1111-100000000004';
const MEM_B_PRIVATE         = 'bbbbbbbb-cccc-2222-2222-200000000001';

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set for the real-schema RLS contract suite');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');

  const migrationFiles = fs.readdirSync(REAL_MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of migrationFiles) {
    await client.query(fs.readFileSync(path.join(REAL_MIGRATIONS_DIR, f), 'utf8'));
  }

  // Fixtures applied as the bootstrap superuser (BYPASSRLS by default).
  await client.query(fs.readFileSync(path.join(DIR, 'fixtures.sql'), 'utf8'));
  await client.end();
});

function quoteIdent(name) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`unsafe identifier: ${name}`);
  }
  return name;
}

function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function withContext(client, ctx, fn) {
  await client.query('BEGIN');
  try {
    if (ctx.role) {
      await client.query(`SET LOCAL ROLE ${quoteIdent(ctx.role)}`);
    }
    if (ctx.pilot) {
      await client.query(`SET LOCAL app.pilot_instance_id = ${quoteLiteral(ctx.pilot)}`);
    }
    if (ctx.user) {
      await client.query(`SET LOCAL app.user_id = ${quoteLiteral(ctx.user)}`);
    }
    if (ctx.userRole) {
      await client.query(`SET LOCAL app.user_role = ${quoteLiteral(ctx.userRole)}`);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
  }
}

async function visibleIds(client, table, idColumn) {
  const r = await client.query(`SELECT ${quoteIdent(idColumn)} AS id FROM ${quoteIdent(table)}`);
  return r.rows.map((row) => row.id);
}

let clientRef = null;

async function setup() {
  if (clientRef) return clientRef;
  clientRef = new Client({ connectionString: DATABASE_URL });
  await clientRef.connect();
  return clientRef;
}

test.after(async () => {
  if (clientRef) {
    try { await clientRef.end(); } catch { /* ignore */ }
    clientRef = null;
  }
});

// ---------------------------------------------------------------------
// Tenant isolation
// ---------------------------------------------------------------------

test('real-schema: cross-pilot — senior-A sees no rows from pilot B', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const pilots = await visibleIds(client, 'pilot_instances', 'id');
    assert.deepEqual(pilots.sort(), [PILOT_A]);

    const memories = await visibleIds(client, 'memory_store', 'id');
    assert.equal(memories.includes(MEM_B_PRIVATE), false, 'must not see pilot B memory');

    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('real-schema: cross-pilot — admin-A cannot see pilot B audit log', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const events = await visibleIds(client, 'governance_audit_log', 'pilot_instance_id');
    assert.ok(events.every((p) => p === PILOT_A), `admin-A must not see pilot B events; got ${events}`);
  });
});

// ---------------------------------------------------------------------
// memory_store visibility matrix
// ---------------------------------------------------------------------

test('real-schema: memory_store — senior-A sees all of own memories', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    for (const expected of [
      MEM_A_PRIVATE, MEM_A_FAMILY_SHARED, MEM_A_PASSWORD_LOCKED, MEM_A_INADMISSIBLE,
    ]) {
      assert.ok(ids.includes(expected), `senior-A must see ${expected}`);
    }
  });
});

test('real-schema: memory_store — family-A sees only admissible family_shared', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
    assert.equal(ids.includes(MEM_A_PRIVATE), false);
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
    assert.equal(ids.includes(MEM_A_INADMISSIBLE), false);
  });
});

test('real-schema: memory_store — caregiver-A (no family_shared perm) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

test('real-schema: memory_store — admin-A sees no private rows (OQ-14.2)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PRIVATE), false);
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
  });
});

// ---------------------------------------------------------------------
// password_locked vault-session model
// ---------------------------------------------------------------------

test('real-schema: memory_store — senior-A sees password_locked with open session', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.ok(ids.includes(MEM_A_PASSWORD_LOCKED));
  });
});

test('real-schema: memory_store — family-A cannot see password_locked', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false);
  });
});

// ---------------------------------------------------------------------
// Vault + session tables
// ---------------------------------------------------------------------

test('real-schema: memory_vaults — only owner sees vault row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.equal(ids.length, 1);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.deepEqual(ids, [], 'family must not see senior vault');
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vaults', 'id');
    assert.deepEqual(ids, [], 'admin must not see vault content');
  });
});

test('real-schema: memory_vault_sessions — only owner sees sessions', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vault_sessions', 'id');
    assert.equal(ids.length, 2);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_vault_sessions', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// circle_contacts
// ---------------------------------------------------------------------

test('real-schema: circle_contacts — senior sees own circle; family sees only own row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT contact_user_id FROM circle_contacts');
    const contactIds = r.rows.map((row) => row.contact_user_id).sort();
    assert.deepEqual(contactIds, [FAMILY_A, CAREGIVER_A].sort());
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const r = await client.query('SELECT contact_user_id FROM circle_contacts');
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contact_user_id, FAMILY_A);
  });
});

// ---------------------------------------------------------------------
// governance_audit_log
// ---------------------------------------------------------------------

test('real-schema: governance_audit_log — admin sees all in-pilot events', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const r = await client.query('SELECT pilot_instance_id FROM governance_audit_log');
    assert.ok(r.rows.length >= 1);
    assert.ok(r.rows.every((row) => row.pilot_instance_id === PILOT_A));
  });
});

test('real-schema: governance_audit_log — user sees events targeted at them', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT target_user_id FROM governance_audit_log');
    assert.ok(r.rows.every((row) => row.target_user_id === SENIOR_A));
  });
});

// ---------------------------------------------------------------------
// Role-based table grants (defense-in-depth)
// ---------------------------------------------------------------------

test('real-schema: lylo_runtime — SELECT on memory_store is permission-denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM memory_store'),
      /permission denied/i,
      'lylo_runtime must be denied at the table grant level'
    );
  });
});

test('real-schema: lylo_runtime — SELECT on the four config tables works', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('real-schema: lylo_runtime — bootstrap policy lets it list pilot_instances without app.pilot_instance_id', async () => {
  // OQ-15.2 belt-and-suspenders: the role-scoped bootstrap policy
  // gives lylo_runtime unconditional SELECT on pilot_instances so a
  // future env-first GM-16 boot can resolve its pilot id.
  const c = await setup();
  await withContext(c, { role: 'lylo_runtime' /* no app.* set */ }, async (client) => {
    const r = await client.query('SELECT id FROM pilot_instances');
    const ids = r.rows.map((row) => row.id).sort();
    assert.deepEqual(ids, [PILOT_A, PILOT_B].sort(),
      'lylo_runtime bootstrap policy must expose all pilots regardless of session vars');
  });
});

// ---------------------------------------------------------------------
// Write rules
// ---------------------------------------------------------------------

test('real-schema: memory_store INSERT — cannot insert a memory owned by another user', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO memory_store (pilot_instance_id, owning_user_id, content, provenance) '
          + "VALUES ($1, $2, 'rogue', 'USER_STATED')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT for another owning_user_id must be blocked by the WITH CHECK policy'
    );
  });
});

test('real-schema: governance_audit_log INSERT — actor_user_id must match the connecting user', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_audit_log (pilot_instance_id, event_type, actor_user_id, actor_role, outcome) '
          + "VALUES ($1, 'memory.created', $2, 'senior', 'allowed')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT impersonating another actor must be blocked'
    );
  });
});

// ---------------------------------------------------------------------
// Default-deny
// ---------------------------------------------------------------------

test('real-schema: default-deny — lylo_app with no session-variable context sees no rows', async () => {
  const c = await setup();
  await withContext(c, { role: 'lylo_app' /* no pilot / user / role set */ }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// governance_review_queue (GM-23) — real-schema mirror of the synthetic
// proposer/admin/non-visibility matrix.
// ---------------------------------------------------------------------

const REVIEW_A = 'aaaaaaaa-eeee-1111-1111-700000000001';
const REVIEW_B = 'bbbbbbbb-eeee-2222-2222-700000000001';

test('real-schema: governance_review_queue — senior proposer sees own row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A));
    assert.equal(ids.includes(REVIEW_B), false);
  });
});

test('real-schema: governance_review_queue — admin in pilot sees all rows', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A));
    assert.equal(ids.includes(REVIEW_B), false);
  });
});

test('real-schema: governance_review_queue — family/caregiver see nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_queue', 'id'), []);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_queue', 'id'), []);
  });
});

test('real-schema: governance_review_queue — lylo_runtime is denied at the GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_queue'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_review_queue INSERT — impersonation rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_queue '
          + '(pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
          + "VALUES ($1, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $2, 'senior')",
        [PILOT_A, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('real-schema: governance_review_queue append-only — UPDATE raises (trigger fires for superuser)', async () => {
  // The contract suite connects as superuser (DROP+CREATE schema in
  // `before`). The append-only trigger fires regardless of role, so
  // the UPDATE attempt here raises.
  const c = await setup();
  // Use the superuser client outside withContext (no SET LOCAL ROLE).
  await assert.rejects(
    () => c.query('UPDATE governance_review_queue SET decision_policy_ref = $1 WHERE id = $2', ['mutated', REVIEW_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_review_decisions (GM-24) — real-schema RLS, append-only
// trigger, self-review BEFORE-INSERT trigger.
// ---------------------------------------------------------------------

const DECISION_A = 'aaaaaaaa-dddd-1111-1111-800000000001';
const DECISION_B = 'bbbbbbbb-dddd-2222-2222-800000000001';

test('real-schema: governance_review_decisions — admin in pilot sees all rows', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A));
    assert.equal(ids.includes(DECISION_B), false, 'admin must not see pilot-B decisions');
  });
});

test('real-schema: governance_review_decisions — proposer of underlying queue item sees the outcome', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'proposer must see outcome of their staged item');
    assert.equal(ids.includes(DECISION_B), false);
  });
});

test('real-schema: governance_review_decisions — family / caregiver see nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_review_decisions', 'id'), []);
  });
});

test('real-schema: governance_review_decisions — lylo_runtime is denied at the GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_decisions'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_review_decisions INSERT — non-admin rejected (by WITH CHECK, by self-review trigger, or by RLS-narrowed queue lookup)', async () => {
  // Defense in depth: the BEFORE-INSERT trigger fires before
  // RLS WITH CHECK. Under a non-admin role context the trigger's
  // SELECT on governance_review_queue is narrowed by queue RLS,
  // so the trigger may raise "not found" before WITH CHECK gets
  // a chance to reject. If the user happens to also be the
  // proposer, the trigger raises "self-review forbidden".
  // Any of these is an acceptable rejection of the non-admin path.
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', SENIOR_A]
      ),
      /row.level security|new row violates row.level|self-review forbidden|review_queue row .* not found/i
    );
  });
});

test('real-schema: governance_review_decisions INSERT — self-review rejected by BEFORE-INSERT trigger', async () => {
  // The trigger fires regardless of role. Use superuser (bypasses
  // RLS) so we hit the trigger directly; insert a decision where
  // reviewer_user_id == the queue row's proposer_user_id.
  const c = await setup();
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_review_decisions '
        + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
      // REVIEW_A_2 staged by SENIOR_A — same user tries to review.
      [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', SENIOR_A]
    ),
    /self-review forbidden/i
  );
});

test('real-schema: governance_review_decisions INSERT — duplicate review (UNIQUE) rejected', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // REVIEW_A already has DECISION_A seeded; second insert fails UNIQUE.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'rejected', 'rejected_admin_review')",
        [PILOT_A, REVIEW_A, ADMIN_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_review_decisions append-only — UPDATE raises (trigger fires for superuser)', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('UPDATE governance_review_decisions SET review_reason = $1 WHERE id = $2', ['mutated', DECISION_A]),
    /append.only/i
  );
});

test('real-schema: governance_review_decisions append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_review_decisions WHERE id = $1', [DECISION_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_authorizations (GM-25) — real-schema RLS,
// append-only trigger, preconditions BEFORE-INSERT trigger
// (review must be approved + authorizer != reviewer + scope ↔ intent).
// ---------------------------------------------------------------------

const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN2_B = 'bbbbbbbb-5555-2222-2222-bbbbbbbbbbbb';
const AUTH_A = 'aaaaaaaa-cccc-1111-1111-900000000001';
const AUTH_B = 'bbbbbbbb-cccc-2222-2222-900000000001';
const DECISION_A_2 = 'aaaaaaaa-dddd-1111-1111-800000000002';
const DECISION_B_2 = 'bbbbbbbb-dddd-2222-2222-800000000002';

test('real-schema: governance_execution_authorizations — admin sees authorization rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_authorizations', 'id');
    assert.ok(ids.includes(AUTH_A));
    assert.equal(ids.includes(AUTH_B), false);
  });
});

test('real-schema: governance_execution_authorizations — proposer / family / caregiver see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_authorizations', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_authorizations — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_authorizations'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_authorizations INSERT — self-authorization rejected by BEFORE-INSERT trigger', async () => {
  // Bypass RLS via superuser to hit the trigger directly. The
  // reviewer of DECISION_A_2 is ADMIN_A; inserting an authorization
  // by ADMIN_A for that decision triggers the self-authorization check.
  const c = await setup();
  // First need a never-authorized approved decision. Insert a fresh
  // one via superuser (RLS bypassed) so we don't collide with UNIQUE.
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000099991', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000099991',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000099991',
      ADMIN_A,
    ]
  );
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
      [PILOT_A, 'aaaaaaaa-dddd-1111-1111-800000099991', ADMIN_A]
    ),
    /self-authorization forbidden/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — authorizing a rejected review is rejected by trigger', async () => {
  // DECISION_B is rejected (per fixture). admin2-B tries to authorize it.
  const c = await setup();
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
      [PILOT_B, 'bbbbbbbb-dddd-2222-2222-800000000001', ADMIN2_B]
    ),
    /non-approved review|review_outcome/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — scope mismatch rejected by trigger', async () => {
  // DECISION_A_2's underlying intent is memory.candidate.create.
  // Try to authorize it with a non-matching scope. Use a fresh
  // unauthorized approved decision (DECISION_A_2 already has AUTH_A).
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000099992', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000099992',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000099992',
      ADMIN_A,
    ]
  );
  // Now try to authorize with the wrong scope.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_authorizations '
        + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
        + "VALUES ($1, $2, $3, 'admin', 'future_vault_action', 'admin_explicit_authorization')",
      [PILOT_A, 'aaaaaaaa-dddd-1111-1111-800000099992', ADMIN2_A]
    ),
    /does not match intent type/i
  );
});

test('real-schema: governance_execution_authorizations INSERT — duplicate authorization for same review_decision rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN2_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_authorizations '
          + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
        [PILOT_A, DECISION_A_2, ADMIN2_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_authorizations append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_authorizations SET authorization_reason = 'admin_explicit_authorization' WHERE id = $1", [AUTH_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_authorizations append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_authorizations WHERE id = $1', [AUTH_A]),
    /append.only/i
  );
});

// ---------------------------------------------------------------------
// governance_execution_claims (GM-26) — real-schema RLS,
// append-only trigger, BEFORE-INSERT preconditions trigger
// (authorization-exists + scope-equality + claimant-≠-authorizer +
// surface-↔-scope + review-still-approved).
// ---------------------------------------------------------------------

const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const CLAIM_A = 'aaaaaaaa-bbbb-1111-1111-a00000000001';
const CLAIM_B = 'bbbbbbbb-bbbb-2222-2222-b00000000001';
const AUTH_A_FOR_CLAIM = 'aaaaaaaa-cccc-1111-1111-900000000001';

test('real-schema: governance_execution_claims — admin sees claim rows in pilot', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_claims', 'id');
    assert.ok(ids.includes(CLAIM_A));
    assert.equal(ids.includes(CLAIM_B), false);
  });
});

test('real-schema: governance_execution_claims — proposer / family see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[SENIOR_A, 'senior'], [FAMILY_A, 'family']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_claims', 'id'), []);
    });
  }
});

test('real-schema: governance_execution_claims — lylo_runtime denied at GRANT layer', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_claims'),
      /permission denied/i
    );
  });
});

test('real-schema: governance_execution_claims INSERT — self-claim rejected by BEFORE-INSERT trigger', async () => {
  // Bypass RLS via superuser to hit the trigger directly. AUTH_A
  // was authorized by ADMIN2_A; inserting a claim by ADMIN2_A
  // for the same authorization triggers the self-claim check.
  // First need a never-claimed authorization. Create a fresh
  // queue → review → authorization chain via superuser.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088881', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088881',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088881',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088881',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088881',
      ADMIN2_A,
    ]
  );
  // Now try to claim it as ADMIN2_A — same human who authorized.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088881', ADMIN2_A]
    ),
    /self-claim forbidden/i
  );
});

test('real-schema: governance_execution_claims INSERT — scope drift rejected by trigger', async () => {
  // Create a fresh authorization with scope memory_candidate_admission.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088882', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088882',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088882',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088882',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088882',
      ADMIN2_A,
    ]
  );
  // Try to claim with a DIFFERENT authorization_scope (drift).
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'future_vault_action', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088882', ADMIN3_A]
    ),
    /authorization_scope drift/i
  );
});

test('real-schema: governance_execution_claims INSERT — surface ↔ scope mismatch rejected by trigger', async () => {
  // Create a fresh authorization with scope memory_candidate_admission.
  const c = await setup();
  await c.query(
    'INSERT INTO governance_review_queue '
      + '(id, pilot_instance_id, decision_intent_type, decision_reason, decision_policy_ref, proposer_user_id, proposer_role) '
      + "VALUES ($1, $2, 'memory.candidate.create', 'ai_inferred_requires_review', 'x', $3, 'senior')",
    ['aaaaaaaa-eeee-1111-1111-700000088883', PILOT_A, SENIOR_A]
  );
  await c.query(
    'INSERT INTO governance_review_decisions '
      + '(id, pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'approved', 'approved_admin_review')",
    [
      'aaaaaaaa-dddd-1111-1111-800000088883',
      PILOT_A,
      'aaaaaaaa-eeee-1111-1111-700000088883',
      ADMIN_A,
    ]
  );
  await c.query(
    'INSERT INTO governance_execution_authorizations '
      + '(id, pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
      + "VALUES ($1, $2, $3, $4, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
    [
      'aaaaaaaa-cccc-1111-1111-900000088883',
      PILOT_A,
      'aaaaaaaa-dddd-1111-1111-800000088883',
      ADMIN2_A,
    ]
  );
  // Now claim with MATCHING scope but WRONG surface.
  await assert.rejects(
    () => c.query(
      'INSERT INTO governance_execution_claims '
        + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
        + "VALUES ($1, $2, 'memory_candidate_admission', 'future_vault_action_consumer', $3, 'admin')",
      [PILOT_A, 'aaaaaaaa-cccc-1111-1111-900000088883', ADMIN3_A]
    ),
    /does not fit authorization_scope/i
  );
});

test('real-schema: governance_execution_claims INSERT — replay (duplicate claim) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN3_A, userRole: 'admin',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_claims '
          + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, AUTH_A_FOR_CLAIM, ADMIN3_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('real-schema: governance_execution_claims append-only — UPDATE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query("UPDATE governance_execution_claims SET execution_surface = 'future_memory_admission_consumer' WHERE id = $1", [CLAIM_A]),
    /append.only/i
  );
});

test('real-schema: governance_execution_claims append-only — DELETE raises', async () => {
  const c = await setup();
  await assert.rejects(
    () => c.query('DELETE FROM governance_execution_claims WHERE id = $1', [CLAIM_A]),
    /append.only/i
  );
});
