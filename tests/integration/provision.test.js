'use strict';

/*
 * Provisioning integration tests.
 *
 * Runs scripts/setup/provision-instance.js as a subprocess against a
 * throwaway Postgres, then asserts the runtime can reach `ready`
 * against the seeded database. Also asserts the idempotency and
 * --force refusal paths.
 *
 * Three environment variables are consumed (OQ-16.6):
 *
 *   DATABASE_URL                — bootstrap superuser; used by `before`
 *                                 and the test helpers to reset the
 *                                 schema and read back the paper trail.
 *   LYLO_SETUP_DATABASE_URL     — `lylo_setup` LOGIN role; what the
 *                                 provisioning subprocess connects with.
 *   LYLO_RUNTIME_DATABASE_URL   — `lylo_runtime` LOGIN role; what the
 *                                 runtime boot uses after provisioning.
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
const LYLO_SETUP_DATABASE_URL = process.env.LYLO_SETUP_DATABASE_URL;
const LYLO_RUNTIME_DATABASE_URL = process.env.LYLO_RUNTIME_DATABASE_URL;
const FAST_DELAYS = [5, 5, 5, 5];
const REPO = path.join(__dirname, '..', '..');
const SCRIPT_PATH = path.join(REPO, 'scripts', 'setup', 'provision-instance.js');

const filledCompanion = JSON.parse(
  fs.readFileSync(path.join(REPO, 'tests', 'config', 'valid', 'filled-text-only.json'), 'utf8')
).companion;

before(async () => {
  assert.ok(DATABASE_URL, 'DATABASE_URL (bootstrap superuser) must be set');
  assert.ok(
    LYLO_SETUP_DATABASE_URL,
    'LYLO_SETUP_DATABASE_URL (lylo_setup LOGIN role) must be set'
  );
  assert.ok(
    LYLO_RUNTIME_DATABASE_URL,
    'LYLO_RUNTIME_DATABASE_URL (lylo_runtime LOGIN role) must be set'
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

async function withDb(fn) {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function reset(client) {
  await client.query('TRUNCATE pilot_instances CASCADE');
}

function buildAnswers(overrides) {
  const base = {
    schema_version: '1.0',
    pilot: { org_name: 'Test Org' },
    senior: { username: 'senior1' },
    supported_person: {
      display_name: 'Supported Person',
      timezone: 'UTC',
      locale: 'en-US',
    },
    companion: filledCompanion,
  };
  return Object.assign(base, overrides || {});
}

function writeAnswersFile(obj) {
  const filePath = path.join(os.tmpdir(), `answers-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(obj));
  return filePath;
}

// Run the provisioning script as a subprocess. By default it connects
// as lylo_setup. Tests that want to exercise a misconfiguration (e.g.
// running the script as lylo_runtime) override `env` to point at a
// different URL.
function runScript(args, env) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    env: { ...process.env, LYLO_SETUP_DATABASE_URL, ...(env || {}) },
    encoding: 'utf8',
  });
}

function parseLogLines(output) {
  return output
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
}

test('provision: happy path seeds the four rows and the runtime reaches ready', async () => {
  await withDb(async (c) => reset(c));
  const answersFile = writeAnswersFile(buildAnswers());
  const result = runScript(['--answers', answersFile]);
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 0, `script must exit 0; stdout: ${result.stdout} stderr: ${result.stderr}`);
  const events = parseLogLines(result.stdout);
  assert.ok(events.some((e) => e.event === 'setup.complete'), 'setup.complete must be emitted');
  assert.ok(
    events.some((e) => e.event === 'setup.companion_profile.created'),
    'companion_profile.created must be emitted'
  );

  // Read the pilot id back from the setup.pilot.created event so we
  // can pin it on the runtime boot — the runtime now requires
  // LYLO_PILOT_INSTANCE_ID and the value must match the seeded row.
  const created = events.find((e) => e.event === 'setup.pilot.created');
  assert.ok(created, 'setup.pilot.created event must be present');
  const pilotInstanceId = created.pilot_instance_id;
  assert.match(pilotInstanceId, /^[0-9a-f-]{36}$/);

  // The runtime now reaches ready against the seeded DB, connecting as
  // lylo_runtime through the role-restricted URL.
  const handle = await boot(
    {
      LYLO_RUNTIME_DATABASE_URL,
      LYLO_PILOT_INSTANCE_ID: pilotInstanceId,
      PORT: '13578',
      LYLO_SHELL_MODE: 'true',
    },
    { dbRetryDelaysMs: FAST_DELAYS }
  );
  try {
    assert.equal(handle.getState(), 'ready');
  } finally {
    await handle.shutdown();
  }

  // The paper trail was recorded.
  await withDb(async (c) => {
    const r = await c.query('SELECT step_key, status FROM setup_state ORDER BY step_key');
    const completed = r.rows.filter((row) => row.status === 'complete').map((row) => row.step_key);
    for (const expected of [
      'pilot_provisioned',
      'senior_provisioned',
      'companion_profile_seeded',
      'supported_person_provisioned',
      'provisioning_complete',
    ]) {
      assert.ok(completed.includes(expected), `setup_state must record ${expected}`);
    }
  });
});

test('provision: refuses to re-provision without --force', async () => {
  // The previous test seeded the DB; do not reset.
  const answersFile = writeAnswersFile(buildAnswers());
  const result = runScript(['--answers', answersFile]);
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 1, 'script must exit non-zero when a pilot already exists');
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some((e) => e.event === 'setup.idempotency.refused'),
    `setup.idempotency.refused must be emitted; got events: ${events.map((e) => e.event).join(', ')}`
  );
});

test('provision: --force does not perform destructive reseed in this version', async () => {
  // Pilot still seeded from the first test.
  const answersFile = writeAnswersFile(buildAnswers());
  const result = runScript(['--answers', answersFile, '--force']);
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 1, '--force must exit non-zero in this version');
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some((e) => e.event === 'setup.force.not_implemented'),
    `setup.force.not_implemented must be emitted; got events: ${events.map((e) => e.event).join(', ')}`
  );
});

test('provision: blank companion identity is rejected (no DB touch)', async () => {
  await withDb(async (c) => reset(c));
  const bad = buildAnswers();
  bad.companion = JSON.parse(JSON.stringify(filledCompanion));
  bad.companion.name = '';
  const answersFile = writeAnswersFile(bad);
  const result = runScript(['--answers', answersFile]);
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 1);
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some((e) => e.event === 'setup.answers.invalid'),
    `setup.answers.invalid must be emitted; got: ${events.map((e) => e.event).join(', ')}`
  );
  // DB untouched.
  await withDb(async (c) => {
    const r = await c.query('SELECT COUNT(*)::int AS n FROM pilot_instances');
    assert.equal(r.rows[0].n, 0, 'no pilot rows must have been inserted');
  });
});

test('provision: missing required answer is rejected', async () => {
  await withDb(async (c) => reset(c));
  const bad = buildAnswers();
  bad.pilot = {};
  const answersFile = writeAnswersFile(bad);
  const result = runScript(['--answers', answersFile]);
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 1);
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some((e) => e.event === 'setup.answers.invalid'),
    'setup.answers.invalid must be emitted for a missing required field'
  );
});

test('provision: missing answers file path is rejected', async () => {
  const result = runScript([], { ANSWERS_FILE: '' });
  assert.equal(result.status, 1);
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some((e) => e.event === 'setup.answers.invalid' && /answers file/i.test(e.reason || '')),
    'setup.answers.invalid must be emitted when no answers path is provided'
  );
});

test('provision: missing LYLO_SETUP_DATABASE_URL is rejected', async () => {
  await withDb(async (c) => reset(c));
  const answersFile = writeAnswersFile(buildAnswers());
  // Explicitly blank the setup URL for this invocation only.
  const result = runScript(['--answers', answersFile], { LYLO_SETUP_DATABASE_URL: '' });
  fs.unlinkSync(answersFile);

  assert.equal(result.status, 1);
  const events = parseLogLines(result.stdout);
  assert.ok(
    events.some(
      (e) => e.event === 'setup.env.error' && /LYLO_SETUP_DATABASE_URL/.test(e.reason || '')
    ),
    'setup.env.error must mention LYLO_SETUP_DATABASE_URL'
  );
});
