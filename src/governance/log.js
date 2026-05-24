'use strict';
/*
 * Governance structured JSON-line logger.
 *
 * Sibling of src/runtime/log.js, scripts/setup/log.js,
 * src/companion/log.js, and src/conversation/log.js. Same JSON-line
 * shape, same reserved core fields (ts, level, event, pid), no
 * cross-package imports — the governance module is a leaf and must
 * not import from any other src/ layer.
 *
 * Field discipline (the central GM-21 privacy assertion is the
 * sentinel-scan unit test, which plants secrets inside an intent's
 * payload and evidence and asserts neither appears in any captured
 * log line):
 *   - callers pass only typed metadata: intent_type, decision,
 *     reason, policy_ref.
 *   - intent payload and evidence are NEVER logged.
 *   - core fields (ts, level, event, pid) are reserved and cannot be
 *     overridden by caller-supplied fields.
 */

const RESERVED_FIELDS = new Set(['ts', 'level', 'event', 'pid']);

function emit(level, event, fields) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    pid: process.pid,
  };
  if (fields) {
    for (const key of Object.keys(fields)) {
      if (!RESERVED_FIELDS.has(key)) {
        entry[key] = fields[key];
      }
    }
  }
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function info(event, fields) {
  emit('info', event, fields);
}

function warn(event, fields) {
  emit('warn', event, fields);
}

function error(event, fields) {
  emit('error', event, fields);
}

module.exports = { info, warn, error, emit, RESERVED_FIELDS };
