'use strict';

/*
 * RLS-engagement integration test.
 *
 * Proves that GM-15's real-schema RLS policies are ACTUALLY engaged by
 * the GM-16 connection roles — not silently bypassed by a superuser
 * BYPASSRLS. The synthetic and real-schema rls-contract suites
 * (tests/rls-contract/) prove the policies behave correctly under
 * SET LOCAL ROLE; this file proves the policies behave the same way
 * under the live LOGIN-role connection strings the production runtime
 * and provisioning script will use.
 *
 * Three scenarios (#b, #c, #e from the GM-16 inspection §6):
 *
 *   b. lylo_runtime is denied on memory tables at the GRANT layer.
 *   c. Tenant-scope narrows reads under lylo_runtime even though the
 *      bootstrap policy permits all pilot_instances SELECTs.
 *   e. Provisioning under lylo_runtime fails closed — defense in depth.
 *
 * Schema reset stays on the bootstrap superuser (OQ-16.6).
 */

const test = require('node:test');
const before = test.before;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { boot } = require('../../src/runtime/boot');

const DATABASE_URL = process.env.DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const LYLO_SETUP_DATABASE_URL = process.env.LYLO_SETUP_DATABASE_URL;
const TEST_PORT = 13579;
const FAST_DELAYS = [5, 5, 5, 5];
const REPO = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO, 'scripts', 'setup', 'provision-instance.js');

const filledCompanion = JSON.parse(
  fs.readFileSync(path.join(REPO, 'tests', 'config', 'valid', 'filled-text-only.json'), 'utf8')
).companion;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(
    LYLO_RUNTIME_DATABASE_URL,
    'LYLO_RUNTIME_DATABASE_URL (lylo_runtime LOGIN role) must be set'
  );
  assert.ok(
    LYLO_SETUP_DATABASE_URL,
    'LYLO_SETUP_DATABASE_URL (lylo_setup LOGIN role) must be set'
  );
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const migrationsDir = path.join(REPO, 'db', 'migrations');
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort();
  for (const f of files) {
    await client.query(fs.readFileSync(path.join(migrationsDir, f), 'utf8'));
  }
  await client.end();
});

async function withSuperuser(fn) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function seedPilot(client, orgName) {
  const r = await client.query(
    'INSERT INTO pilot_instances (org_name) VALUES ($1) RETURNING id',
    [orgName]
  );
  return r.rows[0].id;
}

async function seedFullPilot(client, orgName) {
  const pid = await seedPilot(client, orgName);
  const u = await client.query(
    "INSERT INTO users (pilot_instance_id, username, role) VALUES ($1, 'senior-' || $2, 'senior') RETURNING id",
    [pid, orgName]
  );
  const uid = u.rows[0].id;
  await client.query(
    'INSERT INTO companion_profile (pilot_instance_id, companion_name, persona, voice, safety) '
      + 'VALUES ($1, $2, $3, $4, $5)',
    [
      pid,
      filledCompanion.name + ' (' + orgName + ')',
      JSON.stringify(filledCompanion.persona),
      JSON.stringify(filledCompanion.voice),
      JSON.stringify(filledCompanion.safety),
    ]
  );
  await client.query(
    'INSERT INTO supported_person_profile (pilot_instance_id, user_id, display_name) '
      + "VALUES ($1, $2, 'Supported Person ' || $3)",
    [pid, uid, orgName]
  );
  return pid;
}

// Scenario #b: lylo_runtime cannot reach memory tables. The grant
// layer rejects the SELECT before RLS policies are even evaluated.
test('rls-engagement: lylo_runtime is denied on memory_store at the GRANT layer', async () => {
  await withSuperuser(async (c) => {
    await c.query('TRUNCATE pilot_instances CASCADE');
    await seedPilot(c, 'A');
  });

  const client = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await client.connect();
  try {
    await assert.rejects(
      () => client.query('SELECT id FROM memory_store LIMIT 1'),
      /permission denied/i,
      'lylo_runtime must be denied on memory_store'
    );
    // Same for the other tables outside the loader's 4-table allowlist.
    for (const table of [
      'memory_vaults',
      'memory_vault_sessions',
      'governance_audit_log',
      'circle_contacts',
      'users',
    ]) {
      await assert.rejects(
        () => client.query(`SELECT 1 FROM ${table} LIMIT 1`),
        /permission denied/i,
        `lylo_runtime must be denied on ${table}`
      );
    }
  } finally {
    await client.end();
  }
});

// Scenario #c: with two pilots seeded, boot pinned to pilot A must
// read only pilot A's companion_profile, even though the bootstrap
// policy lets lylo_runtime see all pilot_instances rows.
test('rls-engagement: tenant-scope narrows reads under lylo_runtime to the env-pinned pilot', async () => {
  let pilotA;
  let pilotB;
  await withSuperuser(async (c) => {
    await c.query('TRUNCATE pilot_instances CASCADE');
    pilotA = await seedFullPilot(c, 'A');
    pilotB = await seedFullPilot(c, 'B');
  });

  // First: verify the bootstrap policy lets lylo_runtime list BOTH
  // pilots when no app.pilot_instance_id is set. This is the
  // belt-and-suspenders behavior the policy was added for.
  const baseline = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await baseline.connect();
  try {
    const r = await baseline.query('SELECT id FROM pilot_instances ORDER BY org_name');
    assert.equal(
      r.rows.length,
      2,
      'bootstrap policy must let lylo_runtime see all pilot_instances rows when app.pilot_instance_id is unset'
    );
  } finally {
    await baseline.end();
  }

  // Boot pinned to pilot A. The loader's set_config narrows every
  // SELECT under tenant-scope. We then verify the runtime reached
  // ready (= it read companion_profile and supported_person_profile
  // for exactly one pilot) and that, in a fresh transaction under the
  // runtime URL with the same pilot pinned, only pilot A's
  // companion_profile row is visible.
  const handle = await boot(
    {
      LYLO_RUNTIME_DATABASE_URL,
      LYLO_PILOT_INSTANCE_ID: pilotA,
      PORT: String(TEST_PORT),
      LYLO_SHELL_MODE: 'true',
    },
    { dbRetryDelaysMs: FAST_DELAYS }
  );
  try {
    assert.equal(handle.getState(), 'ready');
  } finally {
    await handle.shutdown();
  }

  // Re-verify tenant-scope independently of the loader. We open our
  // own transaction, set the same session variable the loader sets,
  // and confirm only pilot A's companion_profile is visible.
  const client = new Client({ connectionString: LYLO_RUNTIME_DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SELECT set_config($1, $2, true)', [
      'app.pilot_instance_id',
      pilotA,
    ]);
    const r = await client.query('SELECT pilot_instance_id FROM companion_profile');
    await client.query('COMMIT');
    assert.equal(r.rows.length, 1, 'tenant-scope must narrow companion_profile to one row');
    assert.equal(r.rows[0].pilot_instance_id, pilotA);
    assert.notEqual(r.rows[0].pilot_instance_id, pilotB);
  } finally {
    await client.end();
  }
});

// Scenario #e: misconfiguration defense. Running the provisioning
// script as lylo_runtime (no INSERT grants) must fail at the seed
// INSERT, not silently succeed.
test('rls-engagement: provisioning under lylo_runtime fails closed', async () => {
  await withSuperuser(async (c) => {
    await c.query('TRUNCATE pilot_instances CASCADE');
  });

  const answers = {
    schema_version: '1.0',
    pilot: { org_name: 'Misconfigured' },
    senior: { username: 'senior-misconfig' },
    supported_person: {
      display_name: 'Should Not Exist',
      timezone: 'UTC',
      locale: 'en-US',
    },
    companion: filledCompanion,
  };
  const answersFile = path.join(
    os.tmpdir(),
    `answers-misconfig-${Date.now()}-${Math.random()}.json`
  );
  fs.writeFileSync(answersFile, JSON.stringify(answers));

  // Point the script at the runtime URL — wrong role.
  const result = spawnSync('node', [SCRIPT_PATH, '--answers', answersFile], {
    env: {
      ...process.env,
      LYLO_SETUP_DATABASE_URL: LYLO_RUNTIME_DATABASE_URL,
    },
    encoding: 'utf8',
  });
  fs.unlinkSync(answersFile);

  assert.equal(
    result.status,
    1,
    `provisioning under lylo_runtime must exit non-zero; stdout: ${result.stdout}`
  );
  const events = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  assert.ok(
    events.some((e) => e.event === 'setup.db.error'),
    `setup.db.error must be emitted; got: ${events.map((e) => e.event).join(', ')}`
  );

  // And the DB must remain untouched.
  await withSuperuser(async (c) => {
    const r = await c.query('SELECT COUNT(*)::int AS n FROM pilot_instances');
    assert.equal(r.rows[0].n, 0, 'no pilot row must have been inserted');
  });
});
