'use strict';
/*
 * Validation hook.
 *
 * Maps a loaded companion configuration to a config outcome that the
 * runtime-state model consumes. The single interpreter of the
 * configuration contract is the GM-6 validation core; this module never
 * reimplements validation — it imports and calls it.
 *
 * It performs no database or network I/O. (The GM-6 core reads the
 * static schema file, config/companion.schema.json.)
 *
 * Fail-closed: anything that is not a clean, complete configuration
 * maps to a non-`valid` outcome.
 */

const {
  validateCompanionConfig,
} = require('../../scripts/validate/validate-companion-config');

// Config outcomes — consumed by runtime-state.deriveBootState.
const OUTCOMES = Object.freeze({
  ABSENT: 'absent',
  INVALID: 'invalid',
  INCOMPLETE: 'incomplete',
  VALID: 'valid',
});

/*
 * Assess a loaded companion configuration.
 *
 *   config - the reassembled configuration object, or null/undefined
 *            when no companion_profile row exists yet
 *
 * Returns { outcome, errors }:
 *   'absent'     - no configuration row exists
 *   'invalid'    - structurally invalid (fails template validation), or
 *                  validation threw (malformed schema / bad input)
 *   'incomplete' - structurally valid but identity fields are blank
 *                  (template passes, deployed fails) — setup unfinished
 *   'valid'      - passes deployed-mode validation
 */
function assessConfig(config) {
  if (config === null || config === undefined) {
    return { outcome: OUTCOMES.ABSENT, errors: [] };
  }

  // Step 1 — structural validity (template mode).
  let template;
  try {
    template = validateCompanionConfig(config, 'template');
  } catch (e) {
    return { outcome: OUTCOMES.INVALID, errors: [`validation error: ${e.message}`] };
  }
  if (!template.valid) {
    return { outcome: OUTCOMES.INVALID, errors: template.errors };
  }

  // Step 2 — completeness (deployed mode). Template passed, so any
  // remaining errors are the identity-field non-empty checks.
  let deployed;
  try {
    deployed = validateCompanionConfig(config, 'deployed');
  } catch (e) {
    return { outcome: OUTCOMES.INVALID, errors: [`validation error: ${e.message}`] };
  }
  if (!deployed.valid) {
    return { outcome: OUTCOMES.INCOMPLETE, errors: deployed.errors };
  }

  return { outcome: OUTCOMES.VALID, errors: [] };
}

module.exports = { assessConfig, OUTCOMES };
