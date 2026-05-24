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
 *
 * GM-16 wired the loader to the `lylo_runtime` DB role and made the
 * pilot identity env-first: the caller passes the UUID parsed from
 * LYLO_PILOT_INSTANCE_ID, the loader sets app.pilot_instance_id via
 * set_config inside the transaction so tenant-scope RLS narrows every
 * subsequent SELECT, and a single presence check confirms the pilot
 * row exists before the config reads run.
 */

const { loadSchema } = require('../../scripts/validate/validate-companion-config');

// The configuration contract version the running code is built against.
// It is injected on reassembly — companion_profile does not store it
// (see docs/governance/companion-config-contract.md section 9).
const CONTRACT_VERSION = loadSchema().properties.schema_version.const;

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
 * dedicated client, binds the pilot identity to the transaction's
 * app.pilot_instance_id session variable so tenant-scoped RLS policies
 * narrow every SELECT, verifies the pilot row exists, then runs the
 * four config SELECTs.
 *
 *   pool    - the pg pool
 *   options - { pilotInstanceId } — the UUID parsed from
 *             LYLO_PILOT_INSTANCE_ID by parseEnv; required.
 *
 * Returns:
 *   { ok, pilotInstanceId, reason, config, supportedPersonPresent,
 *     setupState }
 * `ok` is false only for a pilot-resolution failure.
 */
async function loadRuntimeConfig(pool, options) {
  const opts = options || {};
  const pilotInstanceId = opts.pilotInstanceId || null;
  if (!pilotInstanceId) {
    return { ok: false, reason: 'LYLO_PILOT_INSTANCE_ID is required' };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');

    // Bind the pilot identity to the transaction. set_config(name,
    // value, is_local=true) is the parameter-safe equivalent of
    // `SET LOCAL`; it reverts at COMMIT/ROLLBACK and never escapes the
    // transaction. Every subsequent SELECT in this transaction is
    // narrowed by the tenant-scope RLS policy that reads
    // current_setting('app.pilot_instance_id', true).
    await client.query('SELECT set_config($1, $2, true)', [
      'app.pilot_instance_id',
      pilotInstanceId,
    ]);

    // Presence check. Under lylo_runtime's bootstrap policy this
    // SELECT can see all pilot_instances rows, so a 0-row result here
    // is an unambiguous "no such pilot" (not "tenant-scope hid it").
    const presence = await client.query(
      'SELECT 1 FROM pilot_instances WHERE id = $1',
      [pilotInstanceId]
    );
    if (presence.rowCount === 0) {
      await client.query('COMMIT');
      return {
        ok: false,
        reason: 'LYLO_PILOT_INSTANCE_ID does not match any pilot_instances row',
      };
    }

    const companionRes = await client.query(
      'SELECT companion_name, persona, voice, safety FROM companion_profile WHERE pilot_instance_id = $1',
      [pilotInstanceId]
    );
    const supportedRes = await client.query(
      'SELECT display_name, timezone, locale, preferences FROM supported_person_profile WHERE pilot_instance_id = $1',
      [pilotInstanceId]
    );
    // setup_state is read for diagnostics only — it never decides the
    // runtime state. The loader's validation is authoritative.
    const setupRes = await client.query(
      'SELECT step_key, status FROM setup_state WHERE pilot_instance_id = $1',
      [pilotInstanceId]
    );

    await client.query('COMMIT');

    return {
      ok: true,
      pilotInstanceId,
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
  reassembleConfig,
  CONTRACT_VERSION,
};
