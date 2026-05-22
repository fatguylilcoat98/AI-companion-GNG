'use strict';
/*
 * Runtime state model.
 *
 * Pure: no I/O. Derives the boot-time runtime state from a plain facts
 * object, and applies the post-boot transitions. The GM-7b boot
 * sequence gathers the facts; this module only maps facts -> state.
 *
 * Fail-closed: `ready` is the only state from which companion behavior
 * may mount. Every other state withholds it. See
 * docs/governance/companion-config-contract.md.
 */

const STATES = Object.freeze({
  INERT: 'inert',
  SETUP_INCOMPLETE: 'setup-incomplete',
  CONFIGURATION_INVALID: 'configuration-invalid',
  READY: 'ready',
  DEGRADED: 'degraded',
});

// Per-state metadata. `ready` is the only state that exposes companion
// behavior. Setup endpoints are offered where remediation is possible.
const STATE_META = Object.freeze({
  [STATES.INERT]: Object.freeze({
    ready: false, allowsSetupEndpoints: false, allowsCompanionRoutes: false,
  }),
  [STATES.SETUP_INCOMPLETE]: Object.freeze({
    ready: false, allowsSetupEndpoints: true, allowsCompanionRoutes: false,
  }),
  [STATES.CONFIGURATION_INVALID]: Object.freeze({
    ready: false, allowsSetupEndpoints: true, allowsCompanionRoutes: false,
  }),
  [STATES.READY]: Object.freeze({
    ready: true, allowsSetupEndpoints: true, allowsCompanionRoutes: true,
  }),
  [STATES.DEGRADED]: Object.freeze({
    ready: false, allowsSetupEndpoints: false, allowsCompanionRoutes: false,
  }),
});

// The config outcomes produced by the validation hook.
const CONFIG_OUTCOMES = Object.freeze(['absent', 'invalid', 'incomplete', 'valid']);

/*
 * Derive the boot-time runtime state from a facts object:
 *   masterSwitch           - the Layer-1 master switch (boolean)
 *   configOutcome          - one of CONFIG_OUTCOMES
 *   supportedPersonPresent - whether a supported_person_profile exists
 *
 * Boot never yields `degraded`: a dependency failure at boot is a
 * `configuration-invalid` outcome supplied by the caller. Throws on a
 * malformed facts object — fail-closed.
 */
function deriveBootState(facts) {
  const f = facts || {};
  if (typeof f.masterSwitch !== 'boolean') {
    throw new Error('deriveBootState: masterSwitch (boolean) is required');
  }
  if (!CONFIG_OUTCOMES.includes(f.configOutcome)) {
    throw new Error(
      `deriveBootState: configOutcome must be one of ${CONFIG_OUTCOMES.join(', ')}`
    );
  }
  if (typeof f.supportedPersonPresent !== 'boolean') {
    throw new Error('deriveBootState: supportedPersonPresent (boolean) is required');
  }

  // Layer-1 off: inert, with no further evaluation.
  if (!f.masterSwitch) return STATES.INERT;

  // A structurally invalid config is fail-closed and is distinct from
  // an unfinished setup.
  if (f.configOutcome === 'invalid') return STATES.CONFIGURATION_INVALID;

  // An absent or incomplete config, or a missing supported person,
  // means setup is not finished.
  if (f.configOutcome === 'absent' || f.configOutcome === 'incomplete') {
    return STATES.SETUP_INCOMPLETE;
  }
  if (!f.supportedPersonPresent) return STATES.SETUP_INCOMPLETE;

  // configOutcome === 'valid' and the supported person is present.
  return STATES.READY;
}

/*
 * Apply a post-boot event. Only the ready <-> degraded transitions
 * exist post-boot; configuration changes are restart-to-apply. An
 * undefined transition leaves the state unchanged.
 */
function applyEvent(currentState, event) {
  if (currentState === STATES.READY && event === 'dependency-lost') {
    return STATES.DEGRADED;
  }
  if (currentState === STATES.DEGRADED && event === 'dependency-restored') {
    return STATES.READY;
  }
  return currentState;
}

function isReady(state) {
  return STATE_META[state] ? STATE_META[state].ready === true : false;
}

function describeState(state) {
  return STATE_META[state] || null;
}

module.exports = {
  STATES,
  STATE_META,
  CONFIG_OUTCOMES,
  deriveBootState,
  applyEvent,
  isReady,
  describeState,
};
