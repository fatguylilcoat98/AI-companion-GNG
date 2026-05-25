'use strict';
/*
 * Forged-Decision constructors.
 *
 * Each named pattern returns an object that LOOKS like a
 * Decision in some specific way but was NOT produced by the
 * classifier's _createDecision factory. The actor's ten-layer
 * verification chain must reject every one of these. If a
 * forgery EVER reaches the DB, that is a substrate bug.
 *
 * The harness deliberately does NOT reach into _BLESSED or
 * _TOKEN inside src/governance/decisions.js. The point of
 * testing the WeakSet defense is that the harness CAN'T
 * acquire a real Decision through a side-channel.
 */

const { Decision } = require('../governance');

// Pattern: plain object that quacks like a Decision but isn't an
// instance. Layer 1 (instanceof) catches it.
function plainObjectForgery(intentTypeStr) {
  return Object.freeze({
    intentType: intentTypeStr,
    decision: 'admissible',
    reason: 'execution_verification_recording_permitted',
    policyRef: 'forged.md §0',
  });
}

// Pattern: plain object with Decision.prototype assigned. Passes
// instanceof but fails isValidDecision (WeakSet check). Layer 2
// catches it.
function prototypeTamperForgery(intentTypeStr) {
  const fake = {
    intentType: intentTypeStr,
    decision: 'admissible',
    reason: 'execution_verification_recording_permitted',
    policyRef: 'forged.md §0',
  };
  Object.setPrototypeOf(fake, Decision.prototype);
  Object.freeze(fake);
  return fake;
}

// Pattern: real (classifier-produced) Decision but for the
// WRONG intent. Layer 4 (intent-type match) catches it.
function wrongIntentForgery(classifier, intentTypes, otherIntent) {
  return classifier({ type: otherIntent });
}

// Pattern: plain object missing a required structural field.
// Layer 1 catches at instanceof; even if instance were faked,
// Layer 5 (structural revalidation) would catch.
function missingFieldForgery(intentTypeStr) {
  return Object.freeze({
    intentType: intentTypeStr,
    decision: 'admissible',
    // reason intentionally omitted
  });
}

// Pattern: real Decision then attempt to mutate. Object.freeze
// rejects writes silently in non-strict, throws in strict. The
// Decision is frozen at construction; mutation cannot reshape
// it. We construct AND mutate here to confirm the freeze holds.
function mutatedAfterFreezeForgery(classifier, intentTypes, ownIntent) {
  const d = classifier({ type: ownIntent });
  let mutationThrew = false;
  try {
    d.decision = 'tampered';
    d.reason = 'tampered';
  } catch (e) {
    mutationThrew = true;
  }
  return { decision: d, mutationThrew };
}

const FORGERY_BY_PATTERN = Object.freeze({
  'plain-object': plainObjectForgery,
  'prototype-tamper': prototypeTamperForgery,
  'wrong-intent': wrongIntentForgery,
  'missing-field': missingFieldForgery,
  'mutated-after-freeze': mutatedAfterFreezeForgery,
});

module.exports = {
  plainObjectForgery,
  prototypeTamperForgery,
  wrongIntentForgery,
  missingFieldForgery,
  mutatedAfterFreezeForgery,
  FORGERY_BY_PATTERN,
};
