'use strict';
/*
 * Scenario loading + validation.
 *
 * loadScenarioFromFile reads a JSON file, parses it, runs
 * structural validation, and returns a frozen scenario object.
 * Any failure throws with a typed error class. The runner
 * never gets a malformed scenario.
 */

const fs = require('node:fs');
const { validateScenario } = require('./schema');

function loadScenarioFromFile(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('loadScenarioFromFile: filePath must be a non-empty string');
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(
      `loadScenarioFromFile: could not read ${filePath} (${err.code || err.name})`
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadScenarioFromFile: ${filePath} is not valid JSON (${err.message.slice(0, 80)})`
    );
  }
  validateScenario(parsed);
  return Object.freeze(parsed);
}

module.exports = { loadScenarioFromFile };
