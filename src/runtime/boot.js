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
    pool = createPool(env.databaseUrl);
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

  async function shutdown() {
    if (monitor) clearInterval(monitor);
    await new Promise((resolve) => healthServer.close(resolve));
    if (pool) await closePool(pool);
  }

  return { getState: () => currentState, shutdown };
}

if (require.main === module) {
  boot(process.env)
    .then((handle) => {
      const stop = () => {
        handle.shutdown().then(() => process.exit(0));
      };
      process.on('SIGTERM', stop);
      process.on('SIGINT', stop);
    })
    .catch((err) => {
      console.log(`[boot] fatal: ${err && err.message ? err.message : 'unknown'}`);
      process.exit(1);
    });
}

module.exports = { boot };
