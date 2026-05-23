'use strict';
/*
 * Boot orchestration.
 *
 * Composes the runtime: parse the environment, derive the runtime
 * state, start the health server. Fail-closed — every failure path
 * lands in a non-ready state. Configuration is restart-to-apply; the
 * only post-boot transition is ready <-> degraded.
 *
 * Logging is operational only. It never emits secrets, the connection
 * string, persona text, or any profile content.
 */

const { parseEnv } = require('./env');
const { STATES, deriveBootState, applyEvent } = require('./runtime-state');
const { assessConfig } = require('./validation-hook');
const { createPool, connectWithRetry, pingDatabase, closePool } = require('../db/client');
const { loadRuntimeConfig } = require('./config-loader');
const { createHealthServer } = require('./health');

const DEPENDENCY_CHECK_INTERVAL_MS = 15000;

function log(message) {
  console.log(`[boot] ${message}`);
}

// Reduce any error to a coarse, non-sensitive class for logging.
// pg errors can echo the connection string in their message; we never
// log the message.
function coarseError(err) {
  if (!err) return 'unknown';
  return err.code || err.name || 'unknown';
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
}

/*
 * Boot the runtime.
 *   rawEnv  - the environment object (process.env, or a test literal)
 *   options - optional test seams: { dbRetryDelaysMs,
 *             dependencyCheckIntervalMs }
 * Returns a handle { getState, shutdown }.
 */
async function boot(rawEnv, options) {
  const opts = options || {};
  const bootTimeMs = Date.now();

  let currentState;
  let pool = null;
  let monitor = null;

  const env = parseEnv(rawEnv);

  if (!env.ok) {
    for (const e of env.errors) log(`environment error: ${e}`);
    currentState = STATES.CONFIGURATION_INVALID;
  } else if (!env.flags.masterSwitch) {
    log('Layer-1 master switch is off — runtime is inert');
    currentState = STATES.INERT;
  } else {
    pool = createPool(env.databaseUrl, { log });
    const conn = await connectWithRetry(pool, { delaysMs: opts.dbRetryDelaysMs, log });
    if (!conn.connected) {
      log('database unreachable after retries');
      currentState = STATES.CONFIGURATION_INVALID;
    } else {
      try {
        const loaded = await loadRuntimeConfig(pool, { envPilotId: env.pilotInstanceId });
        if (!loaded.ok) {
          log(`pilot resolution failed: ${loaded.reason}`);
          currentState = STATES.CONFIGURATION_INVALID;
        } else {
          const assessment = assessConfig(loaded.config);
          if (assessment.outcome === 'invalid') {
            log('companion configuration is invalid');
          }
          currentState = deriveBootState({
            masterSwitch: true,
            configOutcome: assessment.outcome,
            supportedPersonPresent: loaded.supportedPersonPresent,
          });
        }
      } catch {
        log('configuration load failed');
        currentState = STATES.CONFIGURATION_INVALID;
      }
    }
  }

  log(`runtime state: ${currentState}`);

  // The health server starts in every state so the state is observable.
  const healthServer = createHealthServer({
    getState: () => currentState,
    flags: env.flags,
    bootTimeMs,
  });
  await listen(healthServer, env.port);
  log(`health server listening on port ${env.port}`);

  // Post-boot dependency monitor: ready <-> degraded only.
  if (pool && currentState === STATES.READY) {
    const intervalMs = opts.dependencyCheckIntervalMs || DEPENDENCY_CHECK_INTERVAL_MS;
    monitor = setInterval(async () => {
      const reachable = await pingDatabase(pool);
      if (!reachable && currentState === STATES.READY) {
        currentState = applyEvent(currentState, 'dependency-lost');
        log(`runtime state: ${currentState}`);
      } else if (reachable && currentState === STATES.DEGRADED) {
        currentState = applyEvent(currentState, 'dependency-restored');
        log(`runtime state: ${currentState}`);
      }
    }, intervalMs);
    if (monitor.unref) monitor.unref();
  }

  // Shutdown is idempotent — repeated invocations (e.g. a double
  // SIGTERM from an orchestrator) return the in-flight promise object
  // and produce no additional side effects. This deliberately is NOT
  // an async function — an async wrapper would wrap the cached promise
  // in a fresh one on every call, breaking idempotency.
  let shuttingDown = null;
  function shutdown() {
    if (shuttingDown) return shuttingDown;
    shuttingDown = (async () => {
      if (monitor) clearInterval(monitor);
      const closed = new Promise((resolve) => healthServer.close(resolve));
      // Force-drain held keep-alive sockets so the health server cannot
      // hang shutdown waiting for a slow client to release a connection.
      if (typeof healthServer.closeAllConnections === 'function') {
        healthServer.closeAllConnections();
      }
      await closed;
      if (pool) await closePool(pool);
    })();
    return shuttingDown;
  }

  return { getState: () => currentState, shutdown };
}

if (require.main === module) {
  // Fail-fast on programmer errors. A coarse class is logged — never
  // the raw message, which could echo secrets — and the process exits
  // non-zero so the orchestrator can restart it.
  process.on('uncaughtException', (err) => {
    console.log(`[boot] uncaughtException: ${coarseError(err)}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    console.log(`[boot] unhandledRejection: ${coarseError(err)}`);
    process.exit(1);
  });

  boot(process.env)
    .then((handle) => {
      const stop = () => {
        // A shutdown rejection must not silently hang the process; the
        // finally clause guarantees the exit.
        handle
          .shutdown()
          .catch((err) => {
            console.log(`[boot] shutdown error: ${coarseError(err)}`);
          })
          .finally(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      console.log(`[boot] fatal: ${coarseError(err)}`);
      process.exit(1);
    });
}

module.exports = { boot };
