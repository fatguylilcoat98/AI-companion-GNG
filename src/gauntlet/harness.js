'use strict';
/*
 * Gauntlet harness — central orchestrator.
 *
 * Takes a frozen scenario, drives setup helpers, runs the named
 * step against the public actor / classifier surface, captures
 * the per-stage trace, renders a council-facing result.
 *
 * Hard rules (enforced by check-gauntlet-boundary.js):
 *
 *   - No `pg` import. DB access happens through src/review/
 *     ctx via createReviewQueuePool + withReviewContext.
 *   - No reaching into src/review/repository or transaction
 *     internals. The harness uses only the public review API
 *     (createReviewQueuePool, closeReviewQueuePool,
 *     withReviewContext, ReviewRepositoryError).
 *   - No model SDK. No HTTP. No scheduling. No fs writes.
 *   - No SQL keywords anywhere in this directory.
 *   - No banned vocabulary (bypass / skip / disable / override /
 *     force / monkeypatch / monkey_patch) — per OQ-30.10(a).
 *
 * Constitutional invariant: the harness exists to TEST the
 * substrate. It must never become a way to circumvent it.
 */

const {
  classifyExecutionIntent,
  INTENT_TYPES,
} = require('../governance');
const {
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  createExecutionAttemptLedgerActor,
  createExecutionOutcomeLedgerActor,
  createExecutionVerificationLedgerActor,
} = require('../actors');

const { createTrace } = require('./trace');
const { renderResult } = require('./result');
const { newChainState, SETUP_DISPATCH } = require('./fixtures');
const { FORGERY_BY_PATTERN } = require('./forgery');

const ACTOR_FACTORIES = Object.freeze({
  createResponseDeliveryActor,
  createReviewQueueActor,
  createReviewDecisionActor,
  createExecutionAuthorizationActor,
  createExecutionClaimLedgerActor,
  createExecutionAttemptLedgerActor,
  createExecutionOutcomeLedgerActor,
  createExecutionVerificationLedgerActor,
});

const INTENT_BY_STRING = Object.freeze(
  Object.fromEntries(Object.entries(INTENT_TYPES).map(([k, v]) => [v, INTENT_TYPES[k]]))
);

// Substitute $lastQueueEntryId, $lastReviewDecisionId,
// $lastAuthorizationId, $lastClaimId, $lastAttemptId,
// $lastOutcomeId tokens in step params with values built up by
// the setup chain. Plain string substitution; no eval, no
// arbitrary expressions.
function substituteChainTokens(params, chainState) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string' || !v.startsWith('$')) {
      out[k] = v;
      continue;
    }
    switch (v) {
      case '$lastQueueEntryId':       out[k] = chainState.queueEntryId; break;
      case '$lastReviewDecisionId':   out[k] = chainState.reviewDecisionId; break;
      case '$lastAuthorizationId':    out[k] = chainState.authorizationId; break;
      case '$lastClaimId':            out[k] = chainState.claimId; break;
      case '$lastAttemptId':          out[k] = chainState.attemptId; break;
      case '$lastOutcomeId':          out[k] = chainState.outcomeId; break;
      default:
        throw new Error(`harness: unknown chain token "${v}"`);
    }
  }
  return out;
}

async function runScenario(scenario, deps) {
  if (!deps || typeof deps !== 'object') {
    throw new Error('runScenario: deps object is required');
  }
  const { reviewPool, resetSchemaAndFixtures } = deps;
  if (!reviewPool) {
    throw new Error('runScenario: deps.reviewPool is required');
  }
  if (typeof resetSchemaAndFixtures !== 'function') {
    throw new Error('runScenario: deps.resetSchemaAndFixtures is required');
  }

  const trace = createTrace();
  const runStartedAt = new Date();
  let actualResult = 'expected_no_op';
  let errorClass = null;
  let decisionShape = null;
  const substrateState = null; // Populated by future probes; placeholder for the schema.

  // Per OQ-30.5: re-apply schema + fixtures for every scenario.
  await trace.timed('fixtures.reset', resetSchemaAndFixtures);

  const chainState = newChainState();

  // Run each setup op in order.
  for (let i = 0; i < scenario.setup.length; i += 1) {
    const op = scenario.setup[i];
    if (op.op === 'fixtures.reset') {
      // Already done above; subsequent fixtures.reset ops in
      // the same scenario re-reset. Rare but supported.
      await trace.timed(`fixtures.reset#${i}`, resetSchemaAndFixtures);
      continue;
    }
    const dispatch = SETUP_DISPATCH[op.op];
    if (!dispatch) {
      throw new Error(`harness: no dispatch for setup op "${op.op}"`);
    }
    await trace.timed(`setup.${op.op}`, () => dispatch(reviewPool, chainState, op));
  }

  // Run the named step.
  try {
    if (scenario.step.kind === 'classifier-call') {
      const intent = INTENT_BY_STRING[scenario.step.intent];
      if (!intent) {
        throw new Error(`harness: unknown intent "${scenario.step.intent}"`);
      }
      const d = await trace.timed('classifier', async () => classifyExecutionIntent({ type: intent }));
      decisionShape = Object.freeze({
        intentType: d.intentType,
        decision: d.decision,
        reasonCategory: d.reason,
      });
      actualResult = d.decision === 'admissible' ? 'expected_admission'
        : d.decision === 'inadmissible' ? 'expected_rejection'
        : 'expected_no_op';
    } else if (scenario.step.kind === 'actor-call') {
      const factory = ACTOR_FACTORIES[scenario.step.actor];
      if (!factory) {
        throw new Error(`harness: unknown actor "${scenario.step.actor}"`);
      }
      const intent = INTENT_BY_STRING[scenario.step.intent];
      if (!intent) {
        throw new Error(`harness: unknown intent "${scenario.step.intent}"`);
      }
      const d = await trace.timed('classifier', async () => classifyExecutionIntent({ type: intent }));
      decisionShape = Object.freeze({
        intentType: d.intentType,
        decision: d.decision,
        reasonCategory: d.reason,
      });
      const actor = factory({ reviewQueuePool: reviewPool });
      const params = Object.assign(
        {},
        {
          pilotInstanceId: scenario.session.pilotInstanceId,
          userId: scenario.session.userId,
          userRole: scenario.session.userRole,
        },
        substituteChainTokens(scenario.step.params || {}, chainState)
      );
      await trace.timed('actor.invoke', () => actor.execute(d, params));
      actualResult = 'expected_admission';
    } else if (scenario.step.kind === 'forged-decision') {
      const factory = ACTOR_FACTORIES[scenario.step.actor];
      if (!factory) {
        throw new Error(`harness: unknown actor "${scenario.step.actor}"`);
      }
      const pattern = scenario.step.forgery;
      const constructor = FORGERY_BY_PATTERN[pattern];
      if (!constructor) {
        throw new Error(`harness: unknown forgery pattern "${pattern}"`);
      }
      const intent = scenario.step.intent
        ? INTENT_BY_STRING[scenario.step.intent]
        : INTENT_TYPES.GOVERNANCE_EXECUTION_VERIFY;
      let forged;
      await trace.timed('forgery.construct', async () => {
        if (pattern === 'wrong-intent' || pattern === 'mutated-after-freeze') {
          const otherIntent = scenario.step.otherIntent
            ? INTENT_BY_STRING[scenario.step.otherIntent]
            : INTENT_TYPES.GOVERNANCE_EXECUTION_OUTCOME_RECORD;
          forged = constructor(classifyExecutionIntent, INTENT_TYPES, otherIntent);
        } else {
          forged = constructor(intent);
        }
      });
      const actor = factory({ reviewQueuePool: reviewPool });
      const params = Object.assign(
        {},
        {
          pilotInstanceId: scenario.session.pilotInstanceId,
          userId: scenario.session.userId,
          userRole: scenario.session.userRole,
        },
        substituteChainTokens(scenario.step.params || {}, chainState)
      );
      // For mutated-after-freeze, forged is {decision, mutationThrew}.
      const decisionToFeed = forged && forged.decision && pattern === 'mutated-after-freeze'
        ? forged.decision
        : forged;
      await trace.timed('actor.invoke', () => actor.execute(decisionToFeed, params));
      actualResult = 'expected_admission';
    } else if (scenario.step.kind === 'static-scan'
            || scenario.step.kind === 'boundary-guard'
            || scenario.step.kind === 'snapshot-check') {
      // Static-scan / boundary-guard / snapshot-check probes do not
      // touch the DB. The runner records the kind in trace and
      // returns expected_no_op; the council classifies via
      // the L-series canaries in adversarial.test.js, not here.
      trace.record(scenario.step.kind, true, 0);
      actualResult = 'expected_no_op';
    } else {
      throw new Error(`harness: unsupported step.kind "${scenario.step.kind}"`);
    }
  } catch (err) {
    errorClass = err && (err.code || err.name) || 'Error';
    // Classify: actor verification failures map to
    // expected_throw; ReviewRepositoryError-wrapped DB
    // failures map to expected_rejection (a real DB-side
    // refusal — trigger, CHECK, UNIQUE, RLS, or GRANT).
    if (errorClass === 'ReviewRepositoryError') {
      actualResult = 'expected_rejection';
    } else {
      actualResult = 'expected_throw';
    }
  }

  const runFinishedAt = new Date();
  return renderResult({
    scenario,
    runStartedAt,
    runFinishedAt,
    actualResult,
    errorClass,
    trace: trace.snapshot(),
    substrateState,
    decisionShape,
  });
}

module.exports = { runScenario, ACTOR_FACTORIES, INTENT_BY_STRING };
