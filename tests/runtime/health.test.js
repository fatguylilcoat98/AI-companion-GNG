'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildHealthResponse } = require('../../src/runtime/health');
const { STATES } = require('../../src/runtime/runtime-state');

const baseCtx = {
  state: STATES.READY,
  flags: { masterSwitch: true, voiceEnabled: false },
  bootTimeMs: 1000,
  nowMs: 6000,
};

test('buildHealthResponse: /healthz is 200 live in every state', () => {
  for (const state of Object.values(STATES)) {
    const r = buildHealthResponse('/healthz', { ...baseCtx, state });
    assert.equal(r.statusCode, 200);
    assert.deepEqual(r.body, { status: 'live' });
  }
});

test('buildHealthResponse: /readyz is 200 only when ready', () => {
  assert.equal(
    buildHealthResponse('/readyz', { ...baseCtx, state: STATES.READY }).statusCode,
    200
  );
  for (const state of [
    STATES.INERT,
    STATES.SETUP_INCOMPLETE,
    STATES.CONFIGURATION_INVALID,
    STATES.DEGRADED,
  ]) {
    const r = buildHealthResponse('/readyz', { ...baseCtx, state });
    assert.equal(r.statusCode, 503);
    assert.equal(r.body.ready, false);
    assert.equal(r.body.state, state);
  }
});

test('buildHealthResponse: /status reports state, readiness, uptime, flags', () => {
  const r = buildHealthResponse('/status', baseCtx);
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.state, STATES.READY);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.uptimeSeconds, 5);
  assert.deepEqual(r.body.flags, { masterSwitch: true, voiceEnabled: false });
});

test('buildHealthResponse: an unknown path is 404', () => {
  assert.equal(buildHealthResponse('/secrets', baseCtx).statusCode, 404);
});

test('buildHealthResponse: no response exposes config, persona, profile, or secrets', () => {
  for (const path of ['/healthz', '/readyz', '/status', '/other']) {
    const serialized = JSON.stringify(buildHealthResponse(path, baseCtx).body);
    for (const forbidden of [
      'persona',
      'companion',
      'voice_id',
      'display_name',
      'preferences',
      'databaseUrl',
      'connectionString',
      'password',
    ]) {
      assert.equal(
        serialized.includes(forbidden),
        false,
        `${path} response must not expose "${forbidden}"`
      );
    }
  }
});
