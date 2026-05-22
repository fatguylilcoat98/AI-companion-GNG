'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  STATES,
  deriveBootState,
  applyEvent,
  isReady,
} = require('../../src/runtime/runtime-state');

const base = { masterSwitch: true, configOutcome: 'valid', supportedPersonPresent: true };

test('deriveBootState: Layer-1 off yields inert', () => {
  assert.equal(deriveBootState({ ...base, masterSwitch: false }), STATES.INERT);
});

test('deriveBootState: an invalid config yields configuration-invalid', () => {
  assert.equal(
    deriveBootState({ ...base, configOutcome: 'invalid' }),
    STATES.CONFIGURATION_INVALID
  );
});

test('deriveBootState: an absent or incomplete config yields setup-incomplete', () => {
  assert.equal(deriveBootState({ ...base, configOutcome: 'absent' }), STATES.SETUP_INCOMPLETE);
  assert.equal(
    deriveBootState({ ...base, configOutcome: 'incomplete' }),
    STATES.SETUP_INCOMPLETE
  );
});

test('deriveBootState: a missing supported person yields setup-incomplete', () => {
  assert.equal(
    deriveBootState({ ...base, supportedPersonPresent: false }),
    STATES.SETUP_INCOMPLETE
  );
});

test('deriveBootState: a valid config with a supported person yields ready', () => {
  assert.equal(deriveBootState(base), STATES.READY);
});

test('deriveBootState: boot never yields degraded', () => {
  for (const configOutcome of ['absent', 'invalid', 'incomplete', 'valid']) {
    for (const masterSwitch of [true, false]) {
      for (const supportedPersonPresent of [true, false]) {
        assert.notEqual(
          deriveBootState({ masterSwitch, configOutcome, supportedPersonPresent }),
          STATES.DEGRADED
        );
      }
    }
  }
});

test('deriveBootState: a malformed facts object throws (fail-closed)', () => {
  assert.throws(() => deriveBootState({ configOutcome: 'valid', supportedPersonPresent: true }));
  assert.throws(() => deriveBootState({ ...base, configOutcome: 'nonsense' }));
  assert.throws(() => deriveBootState({ ...base, supportedPersonPresent: 'yes' }));
});

test('applyEvent: a ready instance that loses a dependency becomes degraded', () => {
  assert.equal(applyEvent(STATES.READY, 'dependency-lost'), STATES.DEGRADED);
});

test('applyEvent: a degraded instance recovers to ready', () => {
  assert.equal(applyEvent(STATES.DEGRADED, 'dependency-restored'), STATES.READY);
});

test('applyEvent: an undefined transition leaves the state unchanged', () => {
  assert.equal(applyEvent(STATES.READY, 'dependency-restored'), STATES.READY);
  assert.equal(applyEvent(STATES.SETUP_INCOMPLETE, 'dependency-lost'), STATES.SETUP_INCOMPLETE);
  assert.equal(applyEvent(STATES.INERT, 'anything'), STATES.INERT);
});

test('isReady: only the ready state is ready', () => {
  assert.equal(isReady(STATES.READY), true);
  for (const s of [
    STATES.INERT,
    STATES.SETUP_INCOMPLETE,
    STATES.CONFIGURATION_INVALID,
    STATES.DEGRADED,
  ]) {
    assert.equal(isReady(s), false);
  }
});
