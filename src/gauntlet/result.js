'use strict';
/*
 * Result JSON rendering.
 *
 * The result is the council-facing artifact. Its shape is
 * locked: only typed fields, no payload content, no error
 * message bodies. The L14 sentinel-scan canary plants known
 * content in a scenario's setup ops and asserts that content
 * never appears in the rendered result. Any field added here
 * that would echo user-controlled content is a process
 * failure — fix the field, not the test.
 */

const { COUNCIL_CLASSIFICATIONS } = require('./schema');
const { inferLayerHit } = require('./trace');

function renderResult({
  scenario,
  runStartedAt,
  runFinishedAt,
  actualResult,
  errorClass,
  trace,
  substrateState,
  decisionShape,
}) {
  const expectedResult = scenario.expect.result;
  const expectedLayerHit = scenario.expect.layerHit;
  const expectedErrorClassMatches = scenario.expect.errorClassMatches;

  const layerHit = inferLayerHit(trace);
  const match = actualResult === expectedResult
    && (expectedLayerHit === null || layerHit === expectedLayerHit)
    && (expectedErrorClassMatches === null
      || (typeof errorClass === 'string' && new RegExp(expectedErrorClassMatches).test(errorClass)));

  return Object.freeze({
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    runStartedAt: runStartedAt.toISOString(),
    runFinishedAt: runFinishedAt.toISOString(),
    durationMs: runFinishedAt.getTime() - runStartedAt.getTime(),
    result: actualResult,
    expectedResult,
    match,
    layerHit,
    expectedLayerHit,
    errorClass: errorClass || null,
    errorClassMatched: expectedErrorClassMatches === null
      ? true
      : (typeof errorClass === 'string' && new RegExp(expectedErrorClassMatches).test(errorClass)),
    decisionShape: decisionShape || null,
    substrateState: substrateState || null,
    trace: trace.map((e) => Object.assign({}, e)),
    council: Object.freeze({
      classification: null,
      notes: null,
    }),
  });
}

// Optional council annotation — used post-hoc when a human
// pastes the result back and adds their classification.
function withCouncilClassification(result, classification, notes) {
  if (!COUNCIL_CLASSIFICATIONS.includes(classification)) {
    throw new Error(
      `withCouncilClassification: classification must be one of ${COUNCIL_CLASSIFICATIONS.join(', ')}`
    );
  }
  if (notes !== null && typeof notes !== 'string') {
    throw new Error('withCouncilClassification: notes must be a string or null');
  }
  return Object.freeze(Object.assign({}, result, {
    council: Object.freeze({ classification, notes }),
  }));
}

module.exports = { renderResult, withCouncilClassification };
