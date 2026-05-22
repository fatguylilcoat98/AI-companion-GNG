#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — configuration contract.
 *
 * Enforces the GM-5 configuration contract:
 *   1. config/companion.schema.json compiles (JSON Schema 2020-12)
 *   2. every object in the schema sets additionalProperties:false
 *   3. the contract version agrees across schema $id, schema const,
 *      and config/companion.example.json
 *   4. companion.example.json validates in template mode
 *   5. companion.example.json keeps every identity field blank
 *   6. every tests/config/valid/ fixture passes template mode
 *   7. every tests/config/invalid/ fixture fails template mode
 *   8. deployed mode accepts a filled config and rejects a blank one
 *
 * This guard is NOT standard-library-only: it depends on ajv (a pinned
 * devDependency). Correct JSON Schema 2020-12 validation must not be
 * hand-rolled. The other baseline guards remain stdlib-only.
 */

const fs = require('fs');
const path = require('path');
const {
  validateCompanionConfig,
  loadSchema,
  DEPLOYED_REQUIRED_NON_EMPTY,
} = require('../validate/validate-companion-config');

const REPO = process.cwd();
const errors = [];

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
}

function listJson(relDir) {
  const abs = path.join(REPO, relDir);
  if (!fs.existsSync(abs)) return [];
  return fs
    .readdirSync(abs)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${relDir}/${name}`);
}

// 1. Schema compiles. A malformed schema throws here.
let schema;
try {
  schema = loadSchema();
  validateCompanionConfig({}, 'template'); // forces ajv.compile
  console.log('Schema compiles (JSON Schema 2020-12): OK');
} catch (e) {
  console.log('FAIL — schema does not compile:');
  console.log(`  - ${e.message}`);
  process.exit(1);
}

// 2. additionalProperties:false on every object schema.
let objectSchemas = 0;
(function auditObjects(node, where) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => auditObjects(item, `${where}[${i}]`));
    return;
  }
  if (node.type === 'object') {
    objectSchemas += 1;
    if (node.additionalProperties !== false) {
      errors.push(`schema: object at ${where} does not set additionalProperties:false`);
    }
  }
  for (const key of Object.keys(node)) {
    auditObjects(node[key], `${where}/${key}`);
  }
})(schema, '#');
console.log(`Object schemas audited for additionalProperties:false: ${objectSchemas}`);

// 3. Version consistency across $id, const, and the example.
const example = readJson('config/companion.example.json');
const constVersion = schema.properties && schema.properties.schema_version
  ? schema.properties.schema_version.const
  : undefined;
const idMatch = typeof schema.$id === 'string' ? schema.$id.match(/\/(\d+\.\d+)\.json$/) : null;
const idVersion = idMatch ? idMatch[1] : undefined;
const exampleVersion = example.schema_version;
if (constVersion === undefined || idVersion === undefined) {
  errors.push('schema: could not determine version from $id and schema_version.const');
} else if (constVersion !== idVersion || constVersion !== exampleVersion) {
  errors.push(
    `version mismatch: schema $id=${idVersion}, schema const=${constVersion}, example=${exampleVersion}`
  );
} else {
  console.log(`Contract version consistent: ${constVersion}`);
}

// 4 + 5. The example validates in template mode and keeps identity blank.
const exampleResult = validateCompanionConfig(example, 'template');
if (!exampleResult.valid) {
  for (const e of exampleResult.errors) errors.push(`companion.example.json (template): ${e}`);
} else {
  console.log('companion.example.json validates (template mode): OK');
}
for (const keys of DEPLOYED_REQUIRED_NON_EMPTY) {
  let cur = example;
  for (const k of keys) cur = cur == null ? undefined : cur[k];
  if (cur !== '') {
    errors.push(`companion.example.json: identity field /${keys.join('/')} must be blank in the master`);
  }
}
if (example.companion && example.companion.voice && example.companion.voice.voice_id !== '') {
  errors.push('companion.example.json: identity field /companion/voice/voice_id must be blank in the master');
}

// 6. Valid fixtures pass template mode.
const validFixtures = listJson('tests/config/valid');
for (const rel of validFixtures) {
  const result = validateCompanionConfig(readJson(rel), 'template');
  if (!result.valid) {
    errors.push(`${rel}: expected template-valid, got errors: ${result.errors.join('; ')}`);
  }
}

// 7. Invalid fixtures fail template mode.
const invalidFixtures = listJson('tests/config/invalid');
for (const rel of invalidFixtures) {
  const result = validateCompanionConfig(readJson(rel), 'template');
  if (result.valid) {
    errors.push(`${rel}: expected template-invalid, but it validated`);
  }
}
console.log(`Fixtures checked: ${validFixtures.length} valid, ${invalidFixtures.length} invalid`);

// 8. Deployed mode: a filled config passes, a blank config fails.
const filled = validFixtures.find((rel) => rel.includes('filled-text-only'));
if (!filled) {
  errors.push('tests/config/valid/filled-text-only.json is required for the deployed-mode check');
} else {
  const deployedFilled = validateCompanionConfig(readJson(filled), 'deployed');
  if (!deployedFilled.valid) {
    errors.push(`${filled}: expected deployed-valid, got errors: ${deployedFilled.errors.join('; ')}`);
  }
  const deployedBlank = validateCompanionConfig(example, 'deployed');
  if (deployedBlank.valid) {
    errors.push('companion.example.json: expected deployed-INvalid (blank identity), but it validated');
  }
}

console.log('Baseline CI — configuration contract');
console.log('------------------------------------');
if (errors.length) {
  console.log('');
  console.log('FAIL — configuration contract violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — configuration contract satisfied.');
