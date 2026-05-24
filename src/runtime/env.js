'use strict';
/*
 * Runtime environment parsing.
 *
 * Pure: reads a raw environment object and returns a typed result. It
 * performs no I/O — no database connection, no network. It only reads
 * strings. LYLO_RUNTIME_DATABASE_URL is read as an opaque string; this
 * module never connects to anything.
 *
 * Fail-closed: a missing or unparseable required variable is reported
 * as an error. The boot sequence treats a non-ok result as fatal.
 *
 * GM-16 wired the runtime onto the `lylo_runtime` DB role and made
 * env-first pilot identity required. The previous `DATABASE_URL` and
 * `PILOT_INSTANCE_ID` variable names are not accepted — see the
 * operator runbook for the migration.
 */

// Environment variable -> result key. Layer 1 is the master switch;
// Layer 3 are capability sub-flags. The historical Layer-2 RLS_ENFORCED
// flag is gone — RLS engagement is now intrinsic to the connection role
// (see docs/governance/feature-flag-model.md and
// docs/governance/rls-privacy-contract.md).
const BOOLEAN_FLAGS = Object.freeze({
  LYLO_SHELL_MODE: 'masterSwitch',
  SETUP_MODE_ENABLED: 'setupModeEnabled',
  VOICE_ENABLED: 'voiceEnabled',
  LEGACY_PROJECT_MODE_ENABLED: 'legacyProjectModeEnabled',
});

const TRUE_VALUES = new Set(['true', '1']);
const FALSE_VALUES = new Set(['false', '0', '']);

// Health/readiness server port. Defaults to 3000 when PORT is unset.
const DEFAULT_PORT = 3000;

// Canonical RFC 4122 textual UUID, case-insensitive. Postgres accepts
// the same shape for the uuid type.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseBoolean(raw) {
  if (raw === undefined || raw === null) return { value: false, error: null };
  const norm = String(raw).trim().toLowerCase();
  if (TRUE_VALUES.has(norm)) return { value: true, error: null };
  if (FALSE_VALUES.has(norm)) return { value: false, error: null };
  return { value: false, error: `expected a boolean (true/false), got "${raw}"` };
}

function parsePort(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { value: DEFAULT_PORT, error: null };
  }
  const norm = String(raw).trim();
  if (!/^[0-9]+$/.test(norm)) {
    return { value: DEFAULT_PORT, error: `expected an integer, got "${raw}"` };
  }
  const n = Number(norm);
  if (n < 1 || n > 65535) {
    return { value: DEFAULT_PORT, error: `expected a port in 1-65535, got "${raw}"` };
  }
  return { value: n, error: null };
}

/*
 * Parse a raw environment object.
 *
 *   rawEnv - an object of environment variables (the caller passes
 *            process.env; tests pass a literal)
 *
 * Returns { ok, errors, flags, runtimeDatabaseUrl, pilotInstanceId,
 *           port, version }.
 */
function parseEnv(rawEnv) {
  const env = rawEnv || {};
  const errors = [];
  const flags = {};

  for (const [name, key] of Object.entries(BOOLEAN_FLAGS)) {
    const { value, error } = parseBoolean(env[name]);
    if (error) errors.push(`${name}: ${error}`);
    flags[key] = value;
  }

  // Runtime database connection string. Required for the runtime to
  // load configuration. Read as an opaque string only; the connecting
  // identity must resolve to the `lylo_runtime` DB role.
  const runtimeDatabaseUrl = env.LYLO_RUNTIME_DATABASE_URL
    ? String(env.LYLO_RUNTIME_DATABASE_URL).trim()
    : '';
  if (!runtimeDatabaseUrl) {
    errors.push('LYLO_RUNTIME_DATABASE_URL: required, but missing or empty');
  }

  // Pilot identity. GM-16 makes this required and UUID-validated;
  // the loader sets app.pilot_instance_id from it before any query so
  // tenant-scoped RLS policies can take effect. The historical
  // PILOT_INSTANCE_ID name is gone.
  const rawPilot = env.LYLO_PILOT_INSTANCE_ID
    ? String(env.LYLO_PILOT_INSTANCE_ID).trim()
    : '';
  let pilotInstanceId = null;
  if (!rawPilot) {
    errors.push('LYLO_PILOT_INSTANCE_ID: required, but missing or empty');
  } else if (!UUID_RE.test(rawPilot)) {
    errors.push(`LYLO_PILOT_INSTANCE_ID: expected a UUID, got "${rawPilot}"`);
  } else {
    pilotInstanceId = rawPilot.toLowerCase();
  }

  // Optional build version override. When absent, boot falls back to
  // package.json#version.
  const version = env.LYLO_VERSION ? String(env.LYLO_VERSION).trim() : null;

  // Health/readiness server port. An unparseable PORT is an error,
  // which the boot sequence treats as configuration-invalid.
  const { value: port, error: portError } = parsePort(env.PORT);
  if (portError) errors.push(`PORT: ${portError}`);

  return {
    ok: errors.length === 0,
    errors,
    flags,
    runtimeDatabaseUrl,
    pilotInstanceId,
    port,
    version,
  };
}

module.exports = { parseEnv, parsePort, BOOLEAN_FLAGS, DEFAULT_PORT, UUID_RE };
