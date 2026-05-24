'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEnv } = require('../../src/runtime/env');

const PILOT_OK = '11111111-1111-1111-1111-111111111111';

test('parseEnv: an empty environment is not ok and flags default to false', () => {
  const result = parseEnv({});
  assert.equal(result.ok, false);
  assert.equal(result.flags.masterSwitch, false);
  assert.equal(result.flags.setupModeEnabled, false);
  assert.equal(result.flags.voiceEnabled, false);
  assert.equal(result.flags.legacyProjectModeEnabled, false);
  assert.ok(result.errors.some((e) => e.includes('LYLO_RUNTIME_DATABASE_URL')));
  assert.ok(result.errors.some((e) => e.includes('LYLO_PILOT_INSTANCE_ID')));
});

test('parseEnv: a complete environment is ok', () => {
  const result = parseEnv({
    LYLO_SHELL_MODE: 'true',
    LYLO_RUNTIME_DATABASE_URL: 'postgres://example/db',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
  });
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.flags.masterSwitch, true);
  assert.equal(result.runtimeDatabaseUrl, 'postgres://example/db');
  assert.equal(result.pilotInstanceId, PILOT_OK);
});

test('parseEnv: rlsEnforced is gone — RLS_ENFORCED is ignored and no rlsEnforced key is present', () => {
  const result = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
    RLS_ENFORCED: 'true',
  });
  assert.equal(result.ok, true);
  assert.equal(result.flags.rlsEnforced, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(result.flags, 'rlsEnforced'), false);
});

test('parseEnv: boolean flags accept true/false/1/0', () => {
  const baseEnv = {
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
  };
  assert.equal(parseEnv({ ...baseEnv, VOICE_ENABLED: 'true' }).flags.voiceEnabled, true);
  assert.equal(parseEnv({ ...baseEnv, VOICE_ENABLED: '1' }).flags.voiceEnabled, true);
  assert.equal(parseEnv({ ...baseEnv, VOICE_ENABLED: 'false' }).flags.voiceEnabled, false);
  assert.equal(parseEnv({ ...baseEnv, VOICE_ENABLED: '0' }).flags.voiceEnabled, false);
});

test('parseEnv: an unparseable boolean is an error', () => {
  const result = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
    VOICE_ENABLED: 'maybe',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('VOICE_ENABLED')));
});

test('parseEnv: LYLO_PILOT_INSTANCE_ID is required, UUID-validated, lowercased, and trimmed', () => {
  // Missing.
  const missing = parseEnv({ LYLO_RUNTIME_DATABASE_URL: 'x' });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('LYLO_PILOT_INSTANCE_ID')));

  // Non-UUID.
  const bad = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: 'not-a-uuid',
  });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /LYLO_PILOT_INSTANCE_ID.*UUID/.test(e)));

  // Uppercase + surrounding whitespace are normalized.
  const upper = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: `  ${PILOT_OK.toUpperCase()}  `,
  });
  assert.equal(upper.ok, true);
  assert.equal(upper.pilotInstanceId, PILOT_OK);
});

test('parseEnv: LYLO_RUNTIME_DATABASE_URL is required and trimmed', () => {
  const result = parseEnv({ LYLO_PILOT_INSTANCE_ID: PILOT_OK });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('LYLO_RUNTIME_DATABASE_URL')));

  const trimmed = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: '  postgres://example/db  ',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
  });
  assert.equal(trimmed.runtimeDatabaseUrl, 'postgres://example/db');
});

test('parseEnv: PORT defaults to 3000 when unset', () => {
  assert.equal(
    parseEnv({ LYLO_RUNTIME_DATABASE_URL: 'x', LYLO_PILOT_INSTANCE_ID: PILOT_OK }).port,
    3000
  );
});

test('parseEnv: a valid PORT is parsed', () => {
  const result = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
    PORT: '8080',
  });
  assert.equal(result.ok, true);
  assert.equal(result.port, 8080);
});

test('parseEnv: a non-numeric PORT is an error', () => {
  const result = parseEnv({
    LYLO_RUNTIME_DATABASE_URL: 'x',
    LYLO_PILOT_INSTANCE_ID: PILOT_OK,
    PORT: 'abc',
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('PORT')));
});

test('parseEnv: an out-of-range PORT is an error', () => {
  const base = { LYLO_RUNTIME_DATABASE_URL: 'x', LYLO_PILOT_INSTANCE_ID: PILOT_OK };
  assert.equal(parseEnv({ ...base, PORT: '0' }).ok, false);
  assert.equal(parseEnv({ ...base, PORT: '70000' }).ok, false);
});

test('parseEnv: LYLO_VERSION is read as an optional string and trimmed', () => {
  const base = { LYLO_RUNTIME_DATABASE_URL: 'x', LYLO_PILOT_INSTANCE_ID: PILOT_OK };
  assert.equal(parseEnv(base).version, null);
  assert.equal(parseEnv({ ...base, LYLO_VERSION: 'v1.2.3' }).version, 'v1.2.3');
  assert.equal(parseEnv({ ...base, LYLO_VERSION: '  v1.2.3  ' }).version, 'v1.2.3');
});

test('parseEnv: the historical DATABASE_URL / PILOT_INSTANCE_ID names are no longer accepted', () => {
  // Supplying only the old names yields the new errors — there is no
  // alias fallback (GM-16 OQ-16.2).
  const result = parseEnv({
    DATABASE_URL: 'postgres://example/db',
    PILOT_INSTANCE_ID: PILOT_OK,
  });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('LYLO_RUNTIME_DATABASE_URL')));
  assert.ok(result.errors.some((e) => e.includes('LYLO_PILOT_INSTANCE_ID')));
});
