'use strict';
/*
 * Runtime configuration loader.
 *
 * Reads the four configuration tables and reassembles the companion
 * configuration object. Every query is SELECT-only, parameterized, and
 * runs inside a READ ONLY transaction.
 *
 * The loader never touches memory_store, memory_vaults,
 * memory_vault_sessions, governance_audit_log, or any conversation /
 * inference table. The four tables below are its entire read surface.
 */

const { loadSchema } = require('../../scripts/validate/validate-companion-config');

// The configuration contract version the running code is built against.
// It is injected on reassembly — companion_profile does not store it
// (see docs/governance/companion-config-contract.md section 9).
const CONTRACT_VERSION = loadSchema().properties.schema_version.const;

/*
 * Decide the pilot from the pilot_instances ids and an optional env
 * pin. Pure — unit-testable without a database.
 *
 * Returns { ok: true, pilotInstanceId } or { ok: false, reason }.
 */
function resolvePilotFrom(ids, envPilotId) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { ok: false, reason: 'no pilot_instances row exists' };
  }
  if (ids.length > 1) {
    return {
      ok: false,
      reason: `expected exactly one pilot_instances row, found ${ids.length}`,
    };
  }
  const pilotInstanceId = ids[0];
  if (envPilotId && envPilotId !== pilotInstanceId) {
    return { ok: false, reason: 'PILOT_INSTANCE_ID does not match the pilot_instances row' };
  }
  return { ok: true, pilotInstanceId };
}

/*
 * Reassemble a companion_profile row into a configuration object.
 * Pure. Returns null when there is no row.
 */
function reassembleConfig(row) {
  if (!row) return null;
  return {
    schema_version: CONTRACT_VERSION,
    companion: {
      name: row.companion_name,
      persona: row.persona,
      voice: row.voice,
      safety: row.safety,
    },
  };
}

/*
 * Load the runtime configuration. Opens a READ ONLY transaction on a
 * dedicated client, runs the four SELECT queries, and returns:
 *   { ok, pilotInstanceId, reason, config, supportedPersonPresent,
 *     setupState }
 * `ok` is false only for a pilot-resolution failure.
 */
async function loadRuntimeConfig(pool, options) {
  const opts = options || {};
  const envPilotId = opts.envPilotId || null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    const pilotRows = await client.query('SELECT id FROM pilot_instances');
    const pilot = resolvePilotFrom(pilotRows.rows.map((r) => r.id), envPilotId);
    if (!pilot.ok) {
      await client.query('COMMIT');
      return { ok: false, reason: pilot.reason };
    }

    const pid = pilot.pilotInstanceId;

    const companionRes = await client.query(
      'SELECT companion_name, persona, voice, safety FROM companion_profile WHERE pilot_instance_id = $1',
      [pid]
    );
    const supportedRes = await client.query(
      'SELECT display_name, timezone, locale, preferences FROM supported_person_profile WHERE pilot_instance_id = $1',
      [pid]
    );
    // setup_state is read for diagnostics only — it never decides the
    // runtime state. The loader's validation is authoritative.
    const setupRes = await client.query(
      'SELECT step_key, status FROM setup_state WHERE pilot_instance_id = $1',
      [pid]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      pilotInstanceId: pid,
      config: reassembleConfig(companionRes.rows[0] || null),
      supportedPersonPresent: supportedRes.rows.length > 0,
      setupState: setupRes.rows,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* the transaction is already gone; nothing to roll back */
    }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  loadRuntimeConfig,
  resolvePilotFrom,
  reassembleConfig,
  CONTRACT_VERSION,
};
