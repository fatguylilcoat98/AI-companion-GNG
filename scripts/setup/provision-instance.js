#!/usr/bin/env node
'use strict';
/*
 * Offline instance provisioning.
 *
 * One-shot CLI: reads an answers JSON file and seeds the minimum four
 * rows (pilot_instances, users senior, companion_profile,
 * supported_person_profile) required for the runtime to reach `ready`.
 * Optionally records paper-trail rows in setup_state.
 *
 * Strictly offline — the runtime must NOT be running against this
 * database while the script writes. No HTTP endpoint, no runtime
 * mounting.
 *
 * Idempotency: refuses to proceed if any pilot_instances row exists
 * unless --force is passed. In this version, --force does NOT perform
 * destructive reset/reseed; it is reserved for a future PR that
 * implements deterministic non-destructive behavior.
 *
 * Usage:
 *   node scripts/setup/provision-instance.js --answers <path>
 *   ANSWERS_FILE=<path> node scripts/setup/provision-instance.js
 *   ... [--force]
 *
 * Reads DATABASE_URL from the environment, identically to the runtime.
 *
 * Logging is structured JSON-line (scripts/setup/log.js — a dedicated
 * sibling logger that mirrors the shape of src/runtime/log.js so log
 * consumers see a uniform format from both processes). The connection
 * string is never logged; database errors are reduced to a coarse
 * class. The provisioning script has zero imports into src/runtime/
 * or src/db/ — the runtime/provisioning boundary is preserved.
 */

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { Client } = require('pg');
const logger = require('./log');
const { validateCompanionConfig } = require('../validate/validate-companion-config');

// Required answers identity fields. Blank values are an error.
const REQUIRED_NON_EMPTY_PATHS = [
  ['pilot', 'org_name'],
  ['senior', 'username'],
  ['supported_person', 'display_name'],
  ['companion', 'name'],
  ['companion', 'persona', 'tone'],
  ['companion', 'persona', 'speaking_style'],
];

// Setup-state paper-trail step keys, in the order the script writes them.
const SETUP_STEPS = Object.freeze([
  'pilot_provisioned',
  'senior_provisioned',
  'companion_profile_seeded',
  'supported_person_provisioned',
  'provisioning_complete',
]);

function describeDbError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'error';
}

function getAtPath(obj, keys) {
  let cur = obj;
  for (const key of keys) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function parseAnswersFile(rawPath) {
  if (!rawPath) {
    return {
      ok: false,
      reason: 'no answers file specified (--answers <path> or ANSWERS_FILE env)',
    };
  }
  const absPath = path.resolve(rawPath);
  if (!fs.existsSync(absPath)) {
    return { ok: false, reason: `answers file does not exist: ${rawPath}` };
  }
  let raw;
  try {
    raw = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    return { ok: false, reason: `could not read answers file: ${describeDbError(err)}` };
  }
  let answers;
  try {
    answers = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `answers file is not valid JSON: ${err.message}` };
  }
  return { ok: true, answers };
}

function validateAnswers(answers) {
  const errors = [];
  for (const keys of REQUIRED_NON_EMPTY_PATHS) {
    const value = getAtPath(answers, keys);
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`/${keys.join('/')} must be non-empty`);
    }
  }
  // The companion sub-object must validate in deployed mode against
  // companion.schema.json (the GM-5 contract).
  const candidate = {
    schema_version: '1.0',
    companion: answers && answers.companion ? answers.companion : null,
  };
  let configResult;
  try {
    configResult = validateCompanionConfig(candidate, 'deployed');
  } catch (err) {
    errors.push(`companion config validation threw: ${err.message}`);
    configResult = { valid: false, errors: [] };
  }
  if (!configResult.valid) {
    for (const e of configResult.errors) errors.push(`companion: ${e}`);
  }
  return { valid: errors.length === 0, errors };
}

async function pilotsExist(client) {
  const r = await client.query('SELECT id FROM pilot_instances LIMIT 1');
  return r.rows.length > 0;
}

async function recordStep(client, pilotInstanceId, stepKey) {
  await client.query(
    'INSERT INTO setup_state (pilot_instance_id, step_key, status, completed_at) VALUES ($1, $2, $3, now())',
    [pilotInstanceId, stepKey, 'complete']
  );
}

/*
 * Provision the four rows + paper trail inside a single transaction.
 * Returns the new pilot_instance_id on success; throws on any error so
 * the caller can ROLLBACK.
 */
async function performInserts(client, answers) {
  const pilotRes = await client.query(
    'INSERT INTO pilot_instances (org_name) VALUES ($1) RETURNING id',
    [answers.pilot.org_name]
  );
  const pilotInstanceId = pilotRes.rows[0].id;
  logger.info('setup.pilot.created', { pilot_instance_id: pilotInstanceId });
  await recordStep(client, pilotInstanceId, 'pilot_provisioned');

  const seniorRes = await client.query(
    "INSERT INTO users (pilot_instance_id, username, role) VALUES ($1, $2, 'senior') RETURNING id",
    [pilotInstanceId, answers.senior.username]
  );
  const seniorId = seniorRes.rows[0].id;
  logger.info('setup.senior.created');
  await recordStep(client, pilotInstanceId, 'senior_provisioned');

  await client.query(
    'INSERT INTO companion_profile (pilot_instance_id, companion_name, persona, voice, safety) '
      + 'VALUES ($1, $2, $3, $4, $5)',
    [
      pilotInstanceId,
      answers.companion.name,
      JSON.stringify(answers.companion.persona),
      JSON.stringify(answers.companion.voice),
      JSON.stringify(answers.companion.safety),
    ]
  );
  logger.info('setup.companion_profile.created');
  await recordStep(client, pilotInstanceId, 'companion_profile_seeded');

  await client.query(
    'INSERT INTO supported_person_profile '
      + '(pilot_instance_id, user_id, display_name, timezone, locale) '
      + 'VALUES ($1, $2, $3, $4, $5)',
    [
      pilotInstanceId,
      seniorId,
      answers.supported_person.display_name,
      answers.supported_person.timezone || null,
      answers.supported_person.locale || null,
    ]
  );
  logger.info('setup.supported_person.created');
  await recordStep(client, pilotInstanceId, 'supported_person_provisioned');

  await recordStep(client, pilotInstanceId, 'provisioning_complete');
  logger.info('setup.setup_state.recorded', { steps: SETUP_STEPS.length });

  return pilotInstanceId;
}

async function main() {
  const { values: args } = parseArgs({
    options: {
      answers: { type: 'string' },
      force: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });

  logger.info('setup.start', { force: !!args.force });

  // 1. Answers file.
  const answersPath = args.answers || process.env.ANSWERS_FILE || null;
  const parsed = parseAnswersFile(answersPath);
  if (!parsed.ok) {
    logger.error('setup.answers.invalid', { reason: parsed.reason });
    process.exit(1);
  }
  const answers = parsed.answers;

  // 2. Validate answers in memory before any database connection.
  const validation = validateAnswers(answers);
  if (!validation.valid) {
    for (const e of validation.errors) {
      logger.error('setup.answers.invalid', { reason: e });
    }
    process.exit(1);
  }

  // 3. Database connection.
  const databaseUrl = process.env.DATABASE_URL || '';
  if (!databaseUrl) {
    logger.error('setup.env.error', { reason: 'DATABASE_URL is required' });
    process.exit(1);
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
  } catch (err) {
    logger.error('setup.db.error', { error_class: describeDbError(err) });
    process.exit(1);
  }

  try {
    // 4. Idempotency.
    const exists = await pilotsExist(client);
    if (exists) {
      if (!args.force) {
        logger.error('setup.idempotency.refused', {
          reason: 'a pilot_instances row already exists; pass --force to acknowledge',
        });
        process.exit(1);
      }
      // OQ-12.6: --force is reserved for a future PR that implements
      // deterministic non-destructive re-provisioning. This version
      // refuses the destructive path explicitly.
      logger.error('setup.force.not_implemented', {
        reason: 'destructive re-provisioning is not implemented in this version; run against a fresh database',
      });
      process.exit(1);
    }

    // 5. Transactional insert.
    await client.query('BEGIN');
    let pilotInstanceId;
    try {
      pilotInstanceId = await performInserts(client, answers);
      await client.query('COMMIT');
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      logger.error('setup.db.error', { error_class: describeDbError(err) });
      process.exit(1);
    }

    logger.info('setup.complete', { pilot_instance_id: pilotInstanceId });
  } finally {
    try {
      await client.end();
    } catch {
      /* ignore */
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    logger.error('setup.fatal', { error_class: describeDbError(err) });
    process.exit(1);
  });
}

module.exports = {
  validateAnswers,
  parseAnswersFile,
  REQUIRED_NON_EMPTY_PATHS,
  SETUP_STEPS,
};
