'use strict';
/*
 * Actors structured JSON-line logger.
 *
 * Sibling of every other module logger (runtime / setup / companion /
 * conversation / governance). Same JSON-line shape, same reserved
 * core fields (ts, level, event, pid), no cross-package imports.
 *
 * The actor logger NEVER carries the response text, the user
 * message, memory content, or the Decision's payload/evidence
 * (none of which the Decision itself even exposes after GM-21).
 * The actor logs only the structured outcome metadata: the
 * intent_type, the decision outcome, the reason, and the
 * actor's outcome (`executed` / `abstained` / `rejected`).
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

function info(event, fields) { emit('info', event, fields); }
function warn(event, fields) { emit('warn', event, fields); }
function error(event, fields) { emit('error', event, fields); }

module.exports = { info, warn, error, emit, RESERVED_FIELDS };
