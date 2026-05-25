'use strict';
/*
 * Per-stage trace capture for the gauntlet runner.
 *
 * Records the stage name, ok/!ok, duration, and (on failure)
 * the typed error class only — never the raw error message,
 * because actor / repository errors may quote DB-side details
 * that are too specific to log structurally.
 */

const LAYER_BY_STAGE = Object.freeze({
  'classifier': 'classifier',
  'actor.verifyDecisionOrThrow': 'actor-layer-1',
  'actor.validateParams': 'actor-layer-7',
  'actor.vocabularyPrecondition': 'actor-layer-8',
  'withReviewContext.begin': 'rls',
  'ctx.invoke': 'db-trigger',
  'withReviewContext.rollback': 'rls',
  'withReviewContext.commit': 'rls',
  'static-scan': 'static-scan',
  'boundary-guard': 'boundary-guard',
  'snapshot-check': 'snapshot',
  'forgery.construct': 'actor-layer-1',
});

function createTrace() {
  const entries = [];

  function record(stage, ok, ms, errorClass) {
    const entry = { stage, ok, ms };
    if (errorClass) entry.errorClass = errorClass;
    entries.push(entry);
  }

  async function timed(stage, fn) {
    const start = Date.now();
    try {
      const out = await fn();
      record(stage, true, Date.now() - start);
      return out;
    } catch (err) {
      const cls = err && (err.code || err.name) || 'Error';
      record(stage, false, Date.now() - start, cls);
      throw err;
    }
  }

  function snapshot() {
    return entries.map((e) => Object.assign({}, e));
  }

  return Object.freeze({ record, timed, snapshot });
}

function inferLayerHit(traceEntries) {
  for (let i = traceEntries.length - 1; i >= 0; i -= 1) {
    const e = traceEntries[i];
    if (!e.ok) {
      return LAYER_BY_STAGE[e.stage] || null;
    }
  }
  return null;
}

module.exports = { createTrace, inferLayerHit, LAYER_BY_STAGE };
