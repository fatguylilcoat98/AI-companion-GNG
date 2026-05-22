'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolvePilotFrom,
  reassembleConfig,
  CONTRACT_VERSION,
} = require('../../src/runtime/config-loader');

test('resolvePilotFrom: zero rows is not ok', () => {
  const r = resolvePilotFrom([], null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /no pilot_instances/);
});

test('resolvePilotFrom: more than one row is not ok', () => {
  const r = resolvePilotFrom(['a', 'b'], null);
  assert.equal(r.ok, false);
  assert.match(r.reason, /exactly one/);
});

test('resolvePilotFrom: exactly one row resolves', () => {
  const r = resolvePilotFrom(['pilot-1'], null);
  assert.equal(r.ok, true);
  assert.equal(r.pilotInstanceId, 'pilot-1');
});

test('resolvePilotFrom: a matching PILOT_INSTANCE_ID resolves', () => {
  assert.equal(resolvePilotFrom(['pilot-1'], 'pilot-1').ok, true);
});

test('resolvePilotFrom: a mismatched PILOT_INSTANCE_ID is not ok', () => {
  const r = resolvePilotFrom(['pilot-1'], 'pilot-2');
  assert.equal(r.ok, false);
  assert.match(r.reason, /PILOT_INSTANCE_ID/);
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
