'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assessConfig, OUTCOMES } = require('../../src/runtime/validation-hook');

function fixture(rel) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', rel), 'utf8'));
}

test('assessConfig: a null or undefined config is absent', () => {
  assert.equal(assessConfig(null).outcome, OUTCOMES.ABSENT);
  assert.equal(assessConfig(undefined).outcome, OUTCOMES.ABSENT);
});

test('assessConfig: a blank template config is incomplete', () => {
  const result = assessConfig(fixture('valid/blank-template.json'));
  assert.equal(result.outcome, OUTCOMES.INCOMPLETE);
  assert.ok(result.errors.length > 0);
});

test('assessConfig: a filled config is valid', () => {
  const result = assessConfig(fixture('valid/filled-text-only.json'));
  assert.equal(result.outcome, OUTCOMES.VALID);
  assert.equal(result.errors.length, 0);
});

test('assessConfig: a filled voice-enabled config is valid', () => {
  assert.equal(
    assessConfig(fixture('valid/filled-voice-enabled.json')).outcome,
    OUTCOMES.VALID
  );
});

test('assessConfig: a structurally invalid config is invalid', () => {
  const result = assessConfig(fixture('invalid/unknown-top-level-key.json'));
  assert.equal(result.outcome, OUTCOMES.INVALID);
  assert.ok(result.errors.length > 0);
});

test('assessConfig: a below-floor posture is invalid', () => {
  assert.equal(
    assessConfig(fixture('invalid/below-floor-posture.json')).outcome,
    OUTCOMES.INVALID
  );
});
