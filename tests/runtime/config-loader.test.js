'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  loadRuntimeConfig,
  reassembleConfig,
  CONTRACT_VERSION,
} = require('../../src/runtime/config-loader');

test('loadRuntimeConfig: missing pilotInstanceId is an immediate not-ok result', async () => {
  // The pool is never consulted — the guard runs before connect.
  const sentinel = {
    connect() {
      throw new Error('pool.connect must not be called when pilotInstanceId is missing');
    },
  };
  const r = await loadRuntimeConfig(sentinel, {});
  assert.equal(r.ok, false);
  assert.match(r.reason, /LYLO_PILOT_INSTANCE_ID/);
});

test('reassembleConfig: a null row yields null', () => {
  assert.equal(reassembleConfig(null), null);
});

test('reassembleConfig: a row becomes a config object isomorphic to companion_profile', () => {
  const cfg = reassembleConfig({
    companion_name: 'Aria',
    persona: { tone: 't' },
    voice: { enabled: false },
    safety: { posture: 'standard' },
  });
  assert.equal(cfg.schema_version, CONTRACT_VERSION);
  assert.equal(cfg.companion.name, 'Aria');
  assert.deepEqual(cfg.companion.persona, { tone: 't' });
  assert.deepEqual(cfg.companion.voice, { enabled: false });
  assert.deepEqual(cfg.companion.safety, { posture: 'standard' });
});

test('reassembleConfig: the contract version is 1.0', () => {
  assert.equal(CONTRACT_VERSION, '1.0');
});
