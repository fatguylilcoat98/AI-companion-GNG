'use strict';
/*
 * Structured JSON-line logger for the provisioning script.
 *
 * Mirrors the shape of src/runtime/log.js so log aggregators see a
 * uniform JSON-line format from both the runtime and the provisioning
 * script (ts, level, event, pid, and caller-supplied fields; core
 * fields reserved and never overridable).
 *
 * It lives in scripts/setup/ so the provisioning script has no
 * imports into src/runtime/ or src/db/. The provisioning boundary —
 * runtime is read-only, provisioning is write-only, neither imports
 * the other — is preserved by construction.
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
