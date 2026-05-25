'use strict';
/*
 * Gauntlet public API — GM-30.
 *
 * Test-only adversarial harness. Per constitutional addendum 2,
 * src/gauntlet/ is mechanically forbidden from being imported
 * by any production / runtime module:
 *
 *   - src/runtime/boot.js MUST NOT import this module.
 *   - src/companion/, src/conversation/, src/memory/,
 *     src/governance/, src/actors/, src/review/ MUST NOT
 *     import this module.
 *
 * The boundary-guard reciprocity (per OQ-30.12) is enforced by
 * the existing six boundary guards plus the new
 * check-gauntlet-boundary.js.
 *
 * Per OQ-30.3 + OQ-30.4 the harness consumes ONLY the public
 * surfaces:
 *   - require('../governance')          (classifier, INTENT_TYPES, Decision)
 *   - require('../actors')              (8 actor factories, OUTCOMES)
 *   - require('../review')              (createReviewQueuePool, closeReviewQueuePool, withReviewContext, ReviewRepositoryError)
 *
 * Direct imports of pg, internal repository modules, transaction
 * modules, memory internals, runtime internals, db internals,
 * setup internals, or model SDKs are mechanically forbidden by
 * the gauntlet boundary guard.
 *
 * Constitutional invariant: VERIFICATION ≠ EXECUTION. The
 * gauntlet exists to PROVE the substrate holds under
 * adversarial input. It must never become a vehicle for
 * smuggling production behavior past the guards.
 */

const { loadScenarioFromFile } = require('./scenario');
const { runScenario } = require('./harness');
const { renderResult, withCouncilClassification } = require('./result');
const {
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_CATEGORIES,
  STEP_KINDS,
  ACTOR_NAMES,
  SETUP_OPS,
  FORGERY_PATTERNS,
  EXPECT_RESULTS,
  LAYERS,
  COUNCIL_CLASSIFICATIONS,
  validateScenario,
} = require('./schema');

module.exports = {
  // Loaders + runners.
  loadScenarioFromFile,
  runScenario,
  renderResult,
  withCouncilClassification,
  validateScenario,
  // Locked vocabularies.
  SCENARIO_SCHEMA_VERSION,
  SCENARIO_CATEGORIES,
  STEP_KINDS,
  ACTOR_NAMES,
  SETUP_OPS,
  FORGERY_PATTERNS,
  EXPECT_RESULTS,
  LAYERS,
  COUNCIL_CLASSIFICATIONS,
};
