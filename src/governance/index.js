'use strict';
/*
 * Governance module public API — GM-21.
 *
 * The first execution-decision layer. Pure-function; produces
 * Decision instances that future actor modules (GM-22+) will be
 * required to obtain BEFORE acting. GM-21 ships the classifier and
 * the typed Decision shape only — no actor exists yet.
 *
 * Public surface:
 *
 *   - classifyExecutionIntent({type, payload?, evidence?})
 *       → Decision
 *     Pure, deterministic, stateless. Default-deny on unknown intent
 *     types or malformed inputs.
 *
 *   - Decision
 *     Frozen class. Future actor modules `instanceof`-check Decision
 *     to ensure they only operate on classified intents. The
 *     constructor throws when called externally — Decisions are
 *     unforgeable; the only path is through classifyExecutionIntent.
 *
 *   - INTENT_TYPES
 *     Locked taxonomy. Adding a new intent type requires a paired
 *     classifier branch + REASONS entry + boundary-doc update.
 *
 *   - DECISION_OUTCOMES
 *     The three outcome values: 'admissible' / 'requires_review' /
 *     'inadmissible'.
 *
 *   - REASONS
 *     Locked vocabulary. Every Decision carries a REASONS value AND
 *     a policy citation from POLICY_REFS (looked up by reason).
 *
 * Operations explicitly NOT in this surface:
 *   - any execution path (the classifier produces decisions; it does
 *     not act on them — that's a future actor module's role);
 *   - any persistence (decisions are return values; no DB writes);
 *   - any model SDK call;
 *   - any new audit EVENT_TYPES (the GM-18 lock is unchanged);
 *   - the internal `_createDecision` factory (the only way to obtain
 *     a Decision from outside this module is classifyExecutionIntent).
 *
 * Layer ordering (forward-looking, OQ-21.10): when a future GM
 * introduces an actor module, its contract is:
 *
 *   1. Caller constructs an intent.
 *   2. Caller invokes classifyExecutionIntent(intent) → Decision.
 *   3. Caller passes the Decision (not the intent) to the actor.
 *   4. Actor verifies decision.intentType matches its purpose.
 *   5. Actor proceeds only if decision.decision === 'admissible'.
 *   6. Actor emits its own audit row with intent_type, decision,
 *      reason, policyRef (using new EVENT_TYPES added in the same
 *      future GM).
 *
 * Steps 3-6 are not in GM-21. Step 1-2 are.
 */

const { classifyExecutionIntent } = require('./classifier');
const { Decision, DECISION_OUTCOMES, REASONS, isValidDecision } = require('./decisions');
const { INTENT_TYPES } = require('./intents');

module.exports = {
  classifyExecutionIntent,
  Decision,
  isValidDecision,
  INTENT_TYPES,
  DECISION_OUTCOMES,
  REASONS,
};
