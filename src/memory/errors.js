'use strict';
/*
 * MemoryRepositoryError — the only error shape the memory module
 * propagates when a database operation fails inside a withMemoryContext
 * callback (OQ-18.2).
 *
 * The class is deliberately minimal: a stable `name`, a coarse
 * `error_class` (the SQLSTATE code from pg, or the underlying error's
 * name when no code is present), and a fixed safe message. Crucially
 * it does NOT carry pg's `detail`, `where`, `routine`, `internalQuery`,
 * `table`, `column`, `constraint`, or `parameters` — any of which can
 * echo memory `content`, identifiers, or query parameters into a
 * caller's logs.
 *
 * Caller-contract validation errors (UUID/role/content empty/etc.)
 * are NOT wrapped (OQ-18.7); they remain descriptive plain Error
 * instances. Only pg-originated errors thrown from inside an
 * operation are wrapped.
 */

class MemoryRepositoryError extends Error {
  constructor(errorClass, message) {
    super(message);
    this.name = 'MemoryRepositoryError';
    this.error_class = errorClass;
  }
}

// A pg error has a five-character SQLSTATE in err.code. Caller-contract
// validation errors (plain `new Error(...)`) do not.
function isPgError(err) {
  return (
    err
    && typeof err === 'object'
    && typeof err.code === 'string'
    && err.code.length === 5
  );
}

function describeErrorClass(err) {
  if (!err) return 'unknown';
  if (typeof err.code === 'string' && err.code.length === 5) return err.code;
  return err.name || 'error';
}

module.exports = { MemoryRepositoryError, isPgError, describeErrorClass };
