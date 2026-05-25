'use strict';

/*
 * RLS / privacy contract test matrix.
 *
 * Applies the synthetic schema + candidate policies + fixtures to a
 * throwaway Postgres, then asserts the visibility / write matrix from
 * the perspective of each role × user × tenant combination.
 *
 * Roles, IDs, and policy identifiers are kept in sync with
 * docs/governance/rls-privacy-contract.md.
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
  assert.ok(DATABASE_URL, 'DATABASE_URL must be set for the RLS contract suite');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  // Apply synthetic schema, then fixtures (under superuser, RLS is
  // bypassed for INSERTs), then policies.
  await client.query(fs.readFileSync(path.join(DIR, 'synthetic-schema.sql'), 'utf8'));
  await client.query(fs.readFileSync(path.join(DIR, 'fixtures.sql'), 'utf8'));
  await client.query(fs.readFileSync(path.join(DIR, 'policies.sql'), 'utf8'));
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

// Run a function inside a transaction with a SET LOCAL role and
// session-variable context. The transaction is rolled back at the end
// so each scenario starts clean.
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

test('cross-pilot: senior-A sees no rows from pilot B in any table', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app',
    pilot: PILOT_A,
    user: SENIOR_A,
    userRole: 'senior',
  }, async (client) => {
    const pilots = await visibleIds(client, 'pilot_instances', 'id');
    assert.deepEqual(pilots.sort(), [PILOT_A]);

    const memories = await visibleIds(client, 'memory_store', 'id');
    assert.equal(memories.includes(MEM_B_PRIVATE), false, 'must not see pilot B memory');

    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

test('cross-pilot: admin-A cannot see pilot B audit log', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin',
    pilot: PILOT_A,
    user: ADMIN_A,
    userRole: 'admin',
  }, async (client) => {
    const events = await visibleIds(client, 'governance_audit_log', 'pilot_instance_id');
    assert.ok(events.every((p) => p === PILOT_A), `admin-A must not see pilot B events; got ${events}`);
  });
});

// ---------------------------------------------------------------------
// memory_store visibility matrix
// ---------------------------------------------------------------------

test('memory_store: senior-A sees all of own memories regardless of visibility', async () => {
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

test('memory_store: family-A sees only admissible family_shared of senior-A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids.sort(), [MEM_A_FAMILY_SHARED].sort());
    assert.equal(ids.includes(MEM_A_PRIVATE), false, 'family must NOT see private');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'family must NOT see password_locked');
    assert.equal(ids.includes(MEM_A_INADMISSIBLE), false, 'family must NOT see inadmissible');
  });
});

test('memory_store: caregiver-A (no family_shared permission) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

test('memory_store: admin-A sees no private rows (OQ-14.2 enforced)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.equal(ids.includes(MEM_A_PRIVATE), false, 'admin must NOT see private memories');
    assert.equal(ids.includes(MEM_A_PASSWORD_LOCKED), false, 'admin must NOT see password_locked');
  });
});

// ---------------------------------------------------------------------
// password_locked vault-session model
// ---------------------------------------------------------------------

test('memory_store: senior-A sees password_locked while own session is open', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.ok(ids.includes(MEM_A_PASSWORD_LOCKED));
  });
});

test('memory_store: family-A cannot see password_locked even with family_shared permission', async () => {
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

test('memory_vaults: only the owner sees their vault row', async () => {
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

test('memory_vault_sessions: only the owner sees their sessions', async () => {
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

test('circle_contacts: senior-A sees own circle; family-A sees only their own row', async () => {
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

test('governance_audit_log: admin-A sees all in-pilot events', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const r = await client.query('SELECT pilot_instance_id FROM governance_audit_log');
    assert.ok(r.rows.length >= 1);
    assert.ok(r.rows.every((row) => row.pilot_instance_id === PILOT_A));
  });
});

test('governance_audit_log: a user sees events targeted at them', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const r = await client.query('SELECT target_user_id FROM governance_audit_log');
    assert.ok(r.rows.every((row) => row.target_user_id === SENIOR_A));
  });
});

// ---------------------------------------------------------------------
// Role-based table grants (defense-in-depth: lylo_runtime cannot
// access memory tables at all)
// ---------------------------------------------------------------------

test('lylo_runtime: SELECT on memory_store is permission-denied (no grant)', async () => {
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

test('lylo_runtime: SELECT on the four config tables works (tenant-scoped)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const profiles = await visibleIds(client, 'companion_profile', 'pilot_instance_id');
    assert.deepEqual(profiles, [PILOT_A]);
  });
});

// ---------------------------------------------------------------------
// Write rules — accidental cross-user write blocked
// ---------------------------------------------------------------------

test('memory_store INSERT: a user cannot insert a memory owned by another user', async () => {
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

test('governance_audit_log INSERT: actor_user_id must match the connecting user', async () => {
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
// Default-deny (no policy → zero rows)
// ---------------------------------------------------------------------

test('default-deny: lylo_app with no session-variable context sees no rows', async () => {
  const c = await setup();
  await withContext(c, { role: 'lylo_app' /* no pilot / user / role set */ }, async (client) => {
    // The policies' current_setting(..., true) returns NULL when unset,
    // so the comparison is NULL and the row is filtered out.
    const ids = await visibleIds(client, 'memory_store', 'id');
    assert.deepEqual(ids, []);
  });
});

// ---------------------------------------------------------------------
// governance_review_queue (GM-23): proposer / admin / others visibility
// ---------------------------------------------------------------------

const REVIEW_A = 'aaaaaaaa-eeee-1111-1111-700000000001';
const REVIEW_B = 'bbbbbbbb-eeee-2222-2222-700000000001';

test('governance_review_queue: senior-A (proposer) sees own pending review item', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A), 'proposer must see own pending review row');
    assert.equal(ids.includes(REVIEW_B), false, 'proposer must NOT see pilot-B review row');
  });
});

test('governance_review_queue: admin-A sees all pending review items in pilot A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_A), 'admin must see review-queue rows in pilot');
    assert.equal(ids.includes(REVIEW_B), false, 'admin must NOT see pilot-B review row');
  });
});

test('governance_review_queue: family-A (non-proposer, non-admin) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_queue: caregiver-A sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_queue: cross-pilot — senior-B sees only pilot-B review row', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_B, user: SENIOR_B, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_queue', 'id');
    assert.ok(ids.includes(REVIEW_B));
    assert.equal(ids.includes(REVIEW_A), false);
  });
});

test('governance_review_queue: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_queue'),
      /permission denied/i,
      'lylo_runtime must be denied at the GRANT layer'
    );
  });
});

test('governance_review_queue INSERT: cannot impersonate proposer_user_id', async () => {
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
      /row.level security|new row violates row.level/i,
      'INSERT impersonating another proposer must be blocked'
    );
  });
});

// ---------------------------------------------------------------------
// governance_review_decisions (GM-24): admin sees all in pilot;
// proposer sees the outcome of their own queue item; family /
// caregiver / runtime see nothing. INSERT requires admin role +
// tenant + no impersonation.
// ---------------------------------------------------------------------

const DECISION_A = 'aaaaaaaa-dddd-1111-1111-800000000001';
const DECISION_B = 'bbbbbbbb-dddd-2222-2222-800000000001';

test('governance_review_decisions: admin-A sees the recorded review decision in pilot A', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'admin must see review-decision rows in pilot');
    assert.equal(ids.includes(DECISION_B), false, 'admin must NOT see pilot-B review decision');
  });
});

test('governance_review_decisions: senior-A (proposer of REVIEW_A) sees outcome of their queue item', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.ok(ids.includes(DECISION_A), 'proposer must see their own queue item outcome');
    assert.equal(ids.includes(DECISION_B), false, 'proposer must NOT see pilot-B review decision');
  });
});

test('governance_review_decisions: family-A sees nothing (not proposer, not admin)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_decisions: caregiver-A sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids, []);
  });
});

test('governance_review_decisions: cross-pilot — senior-B sees only pilot-B review decisions', async () => {
  // GM-25 added DECISION_B_2 (approved) to support the
  // authorization-path fixture. Senior-B is the proposer of both
  // underlying queue items, so they see both decisions via the
  // proposer-SELECT policy. Pilot A's DECISION_A / DECISION_A_2
  // must NOT appear.
  const DECISION_B_2_ID = 'bbbbbbbb-dddd-2222-2222-800000000002';
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_B, user: SENIOR_B, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_review_decisions', 'id');
    assert.deepEqual(ids.sort(), [DECISION_B, DECISION_B_2_ID].sort());
  });
});

test('governance_review_decisions: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_review_decisions'),
      /permission denied/i,
      'lylo_runtime must be denied at the GRANT layer'
    );
  });
});

test('governance_review_decisions INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  // senior-A tries to insert a review decision for some other queue item.
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
      /row.level security|new row violates row.level/i,
      'non-admin INSERT must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: admin cannot impersonate another reviewer_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate FAMILY_A as reviewer (with admin role context).
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_A, 'aaaaaaaa-eeee-1111-1111-700000000002', FAMILY_A]
      ),
      /row.level security|new row violates row.level/i,
      'INSERT impersonating a different reviewer_user_id must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // Try to record a decision for pilot B's queue row while
    // operating in pilot A's context. RLS WITH CHECK rejects the
    // pilot mismatch first.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'approved', 'approved_admin_review')",
        [PILOT_B, 'bbbbbbbb-eeee-2222-2222-700000000002', ADMIN_A]
      ),
      /row.level security|new row violates row.level|foreign key/i,
      'cross-pilot INSERT must be blocked'
    );
  });
});

test('governance_review_decisions INSERT: duplicate review (UNIQUE on review_queue_id) rejected', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // REVIEW_A already has DECISION_A (seeded). Trying to file a
    // second one fails on the UNIQUE constraint.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_review_decisions '
          + '(pilot_instance_id, review_queue_id, reviewer_user_id, reviewer_role, review_outcome, review_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'rejected', 'rejected_policy_violation')",
        [PILOT_A, REVIEW_A, ADMIN_A]
      ),
      /duplicate key|unique/i,
      'second review for same queue row must be rejected'
    );
  });
});

// ---------------------------------------------------------------------
// governance_execution_authorizations (GM-25): admin-only SELECT;
// no proposer / reviewer / authorizer / family / caregiver
// visibility. INSERT requires admin role + tenant + no impersonation.
// ---------------------------------------------------------------------

const ADMIN2_A = 'aaaaaaaa-5555-1111-1111-aaaaaaaaaaaa';
const ADMIN2_B = 'bbbbbbbb-5555-2222-2222-bbbbbbbbbbbb';
const AUTH_A = 'aaaaaaaa-cccc-1111-1111-900000000001';
const AUTH_B = 'bbbbbbbb-cccc-2222-2222-900000000001';
const DECISION_A_2 = 'aaaaaaaa-dddd-1111-1111-800000000002';
const REVIEW_A_3 = 'aaaaaaaa-eeee-1111-1111-700000000003';

test('governance_execution_authorizations: admin in pilot sees the recorded authorization', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_authorizations', 'id');
    assert.ok(ids.includes(AUTH_A), 'admin must see authorizations in pilot');
    assert.equal(ids.includes(AUTH_B), false, 'admin must NOT see pilot-B authorizations');
  });
});

test('governance_execution_authorizations: senior-A (proposer) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_authorizations', 'id');
    assert.deepEqual(ids, [], 'proposer must NOT see authorization rows');
  });
});

test('governance_execution_authorizations: family / caregiver see nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: FAMILY_A, userRole: 'family',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_execution_authorizations', 'id'), []);
  });
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: CAREGIVER_A, userRole: 'caregiver',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_execution_authorizations', 'id'), []);
  });
});

test('governance_execution_authorizations: cross-pilot — admin-B sees only pilot-B authorization', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_B, user: 'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_authorizations', 'id');
    assert.deepEqual(ids.sort(), [AUTH_B]);
  });
});

test('governance_execution_authorizations: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_authorizations'),
      /permission denied/i,
      'lylo_runtime must be denied at the GRANT layer'
    );
  });
});

test('governance_execution_authorizations INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_authorizations '
          + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
        [PILOT_A, DECISION_A_2, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('governance_execution_authorizations INSERT: admin cannot impersonate another authorized_by_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate ADMIN2_A as authorizer while connected as ADMIN_A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_authorizations '
          + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
        [PILOT_A, DECISION_A_2, ADMIN2_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('governance_execution_authorizations INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN2_A, userRole: 'admin',
  }, async (client) => {
    // Try to authorize pilot-B's decision while operating in pilot A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_authorizations '
          + '(pilot_instance_id, review_decision_id, authorized_by_user_id, authorized_by_role, authorization_scope, authorization_reason) '
          + "VALUES ($1, $2, $3, 'admin', 'memory_candidate_admission', 'admin_explicit_authorization')",
        [PILOT_B, 'bbbbbbbb-dddd-2222-2222-800000000002', ADMIN2_A]
      ),
      /row.level security|new row violates row.level|foreign key/i
    );
  });
});

test('governance_execution_authorizations INSERT: duplicate authorization for same review_decision rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN2_A, userRole: 'admin',
  }, async (client) => {
    // DECISION_A_2 already has AUTH_A seeded; second attempt fails UNIQUE.
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

// ---------------------------------------------------------------------
// governance_execution_claims (GM-26): admin-only SELECT; no
// proposer / reviewer / authorizer / claimant-as-non-admin /
// family / caregiver visibility. INSERT requires admin role +
// tenant + no impersonation. UNIQUE(execution_authorization_id)
// is the replay-prevention wall.
// ---------------------------------------------------------------------

const ADMIN3_A = 'aaaaaaaa-6666-1111-1111-aaaaaaaaaaaa';
const ADMIN3_B = 'bbbbbbbb-6666-2222-2222-bbbbbbbbbbbb';
const CLAIM_A = 'aaaaaaaa-bbbb-1111-1111-a00000000001';
const CLAIM_B = 'bbbbbbbb-bbbb-2222-2222-b00000000001';
const AUTH_A_FOR_CLAIM = 'aaaaaaaa-cccc-1111-1111-900000000001';

test('governance_execution_claims: admin in pilot sees the recorded claim', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_claims', 'id');
    assert.ok(ids.includes(CLAIM_A), 'admin must see claims in pilot');
    assert.equal(ids.includes(CLAIM_B), false, 'admin must NOT see pilot-B claims');
  });
});

test('governance_execution_claims: senior-A (proposer) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_execution_claims', 'id'), []);
  });
});

test('governance_execution_claims: family / caregiver see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[FAMILY_A, 'family'], [CAREGIVER_A, 'caregiver']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_claims', 'id'), []);
    });
  }
});

test('governance_execution_claims: cross-pilot — pilot-B admin sees only pilot-B claim', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_B, user: 'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_claims', 'id');
    assert.deepEqual(ids.sort(), [CLAIM_B]);
  });
});

test('governance_execution_claims: lylo_runtime has no grant — SELECT permission denied', async () => {
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

test('governance_execution_claims INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_claims '
          + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, AUTH_A_FOR_CLAIM, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('governance_execution_claims INSERT: admin cannot impersonate another claimed_by_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN3_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate ADMIN2_A as claimant while connected as ADMIN3_A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_claims '
          + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, AUTH_A_FOR_CLAIM, ADMIN2_A]
      ),
      /row.level security|new row violates row.level|duplicate key|unique/i
    );
  });
});

test('governance_execution_claims INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN3_A, userRole: 'admin',
  }, async (client) => {
    // Try to claim pilot-B's authorization from pilot A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_claims '
          + '(pilot_instance_id, execution_authorization_id, authorization_scope, execution_surface, claimed_by_user_id, claimed_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_B, 'bbbbbbbb-cccc-2222-2222-900000000001', ADMIN3_A]
      ),
      /row.level security|new row violates row.level|foreign key/i
    );
  });
});

test('governance_execution_claims INSERT: replay (duplicate claim for same authorization) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN3_A, userRole: 'admin',
  }, async (client) => {
    // AUTH_A_FOR_CLAIM already has CLAIM_A seeded; second claim fails UNIQUE.
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

// ---------------------------------------------------------------------
// governance_execution_attempts (GM-27): admin-only SELECT;
// no proposer / reviewer / authorizer / claimant / attempter-
// as-non-admin / family / caregiver visibility. INSERT requires
// admin role + tenant + no impersonation. UNIQUE(execution_claim_id)
// forbids retry / multi-attempt semantics.
// Constitutional rule: ATTEMPT IS NOT OUTCOME.
// ---------------------------------------------------------------------

const ADMIN4_A = 'aaaaaaaa-7777-1111-1111-aaaaaaaaaaaa';
const ADMIN4_B = 'bbbbbbbb-7777-2222-2222-bbbbbbbbbbbb';
const ATTEMPT_A = 'aaaaaaaa-aaaa-1111-1111-c00000000001';
const ATTEMPT_B = 'bbbbbbbb-aaaa-2222-2222-d00000000001';
const CLAIM_A_FOR_ATTEMPT = 'aaaaaaaa-bbbb-1111-1111-a00000000001';

test('governance_execution_attempts: admin in pilot sees the recorded attempt', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_attempts', 'id');
    assert.ok(ids.includes(ATTEMPT_A), 'admin must see attempts in pilot');
    assert.equal(ids.includes(ATTEMPT_B), false, 'admin must NOT see pilot-B attempts');
  });
});

test('governance_execution_attempts: senior-A (proposer) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_execution_attempts', 'id'), []);
  });
});

test('governance_execution_attempts: family / caregiver see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[FAMILY_A, 'family'], [CAREGIVER_A, 'caregiver']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_attempts', 'id'), []);
    });
  }
});

test('governance_execution_attempts: cross-pilot — pilot-B admin sees only pilot-B attempt', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_B, user: 'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_attempts', 'id');
    assert.deepEqual(ids.sort(), [ATTEMPT_B]);
  });
});

test('governance_execution_attempts: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_attempts'),
      /permission denied/i
    );
  });
});

test('governance_execution_attempts INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_attempts '
          + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, CLAIM_A_FOR_ATTEMPT, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('governance_execution_attempts INSERT: admin cannot impersonate another attempted_by_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN4_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate ADMIN3_A as attempter while connected as ADMIN4_A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_attempts '
          + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, CLAIM_A_FOR_ATTEMPT, ADMIN3_A]
      ),
      /row.level security|new row violates row.level|duplicate key|unique/i
    );
  });
});

test('governance_execution_attempts INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN4_A, userRole: 'admin',
  }, async (client) => {
    // Try to record an attempt against pilot-B's claim from pilot A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_attempts '
          + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_B, 'bbbbbbbb-bbbb-2222-2222-b00000000001', ADMIN4_A]
      ),
      /row.level security|new row violates row.level|foreign key/i
    );
  });
});

test('governance_execution_attempts INSERT: replay (duplicate attempt for same claim) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN4_A, userRole: 'admin',
  }, async (client) => {
    // CLAIM_A_FOR_ATTEMPT already has ATTEMPT_A seeded; second attempt fails UNIQUE.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_attempts '
          + '(pilot_instance_id, execution_claim_id, authorization_scope, execution_surface, attempted_by_user_id, attempted_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, 'admin')",
        [PILOT_A, CLAIM_A_FOR_ATTEMPT, ADMIN4_A]
      ),
      /duplicate key|unique/i
    );
  });
});

// ---------------------------------------------------------------------
// governance_execution_outcomes (GM-28): admin-only SELECT;
// no proposer / reviewer / authorizer / claimant / attempter /
// recorder-as-non-admin / family / caregiver visibility. INSERT
// requires admin role + tenant + no impersonation.
// UNIQUE(execution_attempt_id) enforces one outcome per attempt;
// outcomes are OPTIONAL (missing rows are structurally valid).
// Constitutional rule: AN OUTCOME ROW IS NOT TRUTH.
// ---------------------------------------------------------------------

const ADMIN5_A = 'aaaaaaaa-8888-1111-1111-aaaaaaaaaaaa';
const ADMIN5_B = 'bbbbbbbb-8888-2222-2222-bbbbbbbbbbbb';
const OUTCOME_A = 'aaaaaaaa-9999-1111-1111-e00000000001';
const OUTCOME_B = 'bbbbbbbb-9999-2222-2222-f00000000001';
const ATTEMPT_A_FOR_OUTCOME = 'aaaaaaaa-aaaa-1111-1111-c00000000001';

test('governance_execution_outcomes: admin in pilot sees the recorded outcome', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_A, user: ADMIN_A, userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_outcomes', 'id');
    assert.ok(ids.includes(OUTCOME_A), 'admin must see outcomes in pilot');
    assert.equal(ids.includes(OUTCOME_B), false, 'admin must NOT see pilot-B outcomes');
  });
});

test('governance_execution_outcomes: senior-A (proposer) sees nothing', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    assert.deepEqual(await visibleIds(client, 'governance_execution_outcomes', 'id'), []);
  });
});

test('governance_execution_outcomes: family / caregiver see nothing', async () => {
  const c = await setup();
  for (const [user, role] of [[FAMILY_A, 'family'], [CAREGIVER_A, 'caregiver']]) {
    await withContext(c, { role: 'lylo_app', pilot: PILOT_A, user, userRole: role }, async (client) => {
      assert.deepEqual(await visibleIds(client, 'governance_execution_outcomes', 'id'), []);
    });
  }
});

test('governance_execution_outcomes: cross-pilot — pilot-B admin sees only pilot-B outcome', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_admin', pilot: PILOT_B, user: 'bbbbbbbb-4444-2222-2222-bbbbbbbbbbbb', userRole: 'admin',
  }, async (client) => {
    const ids = await visibleIds(client, 'governance_execution_outcomes', 'id');
    assert.deepEqual(ids.sort(), [OUTCOME_B]);
  });
});

test('governance_execution_outcomes: lylo_runtime has no grant — SELECT permission denied', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_runtime', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query('SELECT id FROM governance_execution_outcomes'),
      /permission denied/i
    );
  });
});

test('governance_execution_outcomes INSERT: non-admin role rejected by WITH CHECK', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: SENIOR_A, userRole: 'senior',
  }, async (client) => {
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_completed', $3, 'admin')",
        [PILOT_A, ATTEMPT_A_FOR_OUTCOME, SENIOR_A]
      ),
      /row.level security|new row violates row.level/i
    );
  });
});

test('governance_execution_outcomes INSERT: admin cannot impersonate another recorded_by_user_id', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN5_A, userRole: 'admin',
  }, async (client) => {
    // Impersonate ADMIN4_A as recorder while connected as ADMIN5_A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_completed', $3, 'admin')",
        [PILOT_A, ATTEMPT_A_FOR_OUTCOME, ADMIN4_A]
      ),
      /row.level security|new row violates row.level|duplicate key|unique/i
    );
  });
});

test('governance_execution_outcomes INSERT: cross-pilot rejected (composite FK + RLS)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN5_A, userRole: 'admin',
  }, async (client) => {
    // Try to record an outcome against pilot-B's attempt from pilot A.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_completed', $3, 'admin')",
        [PILOT_B, 'bbbbbbbb-aaaa-2222-2222-d00000000001', ADMIN5_A]
      ),
      /row.level security|new row violates row.level|foreign key/i
    );
  });
});

test('governance_execution_outcomes INSERT: replay (duplicate outcome for same attempt) rejected (UNIQUE)', async () => {
  const c = await setup();
  await withContext(c, {
    role: 'lylo_app', pilot: PILOT_A, user: ADMIN5_A, userRole: 'admin',
  }, async (client) => {
    // ATTEMPT_A_FOR_OUTCOME already has OUTCOME_A seeded; second outcome fails UNIQUE.
    await assert.rejects(
      () => client.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', 'reported_unknown', $3, 'admin')",
        [PILOT_A, ATTEMPT_A_FOR_OUTCOME, ADMIN5_A]
      ),
      /duplicate key|unique/i
    );
  });
});

test('governance_execution_outcomes INSERT: outcome_type outside reported_* vocabulary rejected (CHECK)', async () => {
  const c = await setup();
  // Use superuser to bypass RLS so we hit the CHECK constraint
  // directly (not the WITH CHECK policy).
  for (const bad of ['completed', 'succeeded', 'failed', 'reported_succeeded', 'reported_failed', 'verified_completed']) {
    await assert.rejects(
      () => c.query(
        'INSERT INTO governance_execution_outcomes '
          + '(pilot_instance_id, execution_attempt_id, authorization_scope, execution_surface, outcome_type, recorded_by_user_id, recorded_by_role) '
          + "VALUES ($1, $2, 'memory_candidate_admission', 'future_memory_admission_consumer', $3, $4, 'admin')",
        [PILOT_A, ATTEMPT_A_FOR_OUTCOME, bad, ADMIN5_A]
      ),
      /check constraint|outcome_type/i,
      `forbidden outcome_type "${bad}" must be rejected by CHECK constraint`
    );
  }
});
