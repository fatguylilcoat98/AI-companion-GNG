#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — governance-runtime boundary (GM-21).
 *
 * Mechanically enforces the contract documented in
 * docs/governance/governance-runtime-boundary.md for src/governance/.
 * The governance module is a PURE-FUNCTION LEAF — it must not
 * perform I/O of any kind, must not import any other src/ layer,
 * and must not contain SQL, scheduling, async surface, or any
 * capability that could be repurposed into an actor.
 *
 * Fails the build on:
 *   1. Any forbidden SQL keyword (INSERT, UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE, SELECT, FROM, JOIN,
 *      WHERE). The classifier touches no SQL.
 *   2. Any identifier suggesting execution / mutation / agent-style
 *      behavior: `insertPrivateMemory`, the streaming/tool-calling
 *      surface (`.stream(`, `messages.stream`, `stream: true`,
 *      `tools`, `tool_choice`, `tool_use`, `tool_result`).
 *   3. Imports of `pg`, any model SDK, any HTTP/server framework,
 *      `child_process`, `worker_threads`, `cluster`. The classifier
 *      is a pure function with no external surface.
 *   4. Imports from any other src/ layer (`../memory`, `../companion`,
 *      `../conversation`, `../runtime`, `../db`, `../setup`, or any
 *      subpath thereof). The governance module is a LEAF.
 *   5. Scheduling / async-execution identifiers: `setTimeout`,
 *      `setInterval`, `setImmediate`, `cron`, `schedule`. The
 *      classifier is sync and stateless.
 *   6. Filesystem-write API surface: `fs.writeFile*`,
 *      `fs.appendFile*`, `fs.createWriteStream`, `fs.mkdir*`,
 *      `fs.rm*`, `fs.unlink*`.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and identifiers
 * it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/governance'];

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|SELECT|FROM|JOIN|WHERE)\b/g;

const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Modules whose import is forbidden anywhere in src/governance/.
const FORBIDDEN_MODULE_EXACT = new Set([
  'pg',
  'http',
  'https',
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'child_process',
  'worker_threads',
  'cluster',
  'node:child_process',
  'node:worker_threads',
  'node:cluster',
  // Model SDKs — the classifier never calls a model. Every model SDK
  // is banned by name to make the rule explicit (matches the
  // conversation guard's single-SDK posture, except here NO SDK is
  // approved).
  '@anthropic-ai/sdk',
  'openai',
  'anthropic',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

// Cross-layer import bans. The governance module is a leaf — it
// depends on nothing inside src/ except its own files.
const FORBIDDEN_PATH_PREFIXES = [
  '../memory',
  '../companion',
  '../conversation',
  '../runtime',
  '../db',
  '../setup',
  '../../scripts/setup',
];

// Identifier-level scans (post-comment-stripping).
const FORBIDDEN_IDENTIFIERS = [
  { re: /\binsertPrivateMemory\b/, label: 'insertPrivateMemory (memory-write op)' },
  { re: /\bsetInterval\b/, label: 'setInterval (no scheduling)' },
  { re: /\bsetImmediate\b/, label: 'setImmediate (no scheduling)' },
  { re: /\bsetTimeout\b/, label: 'setTimeout (classifier is sync; no async surface)' },
  { re: /\bcron\b/, label: 'cron (no scheduling)' },
  { re: /\bschedule\b/, label: 'schedule (no scheduling)' },
  { re: /\.stream\s*\(/, label: '.stream( (no streaming surface)' },
  { re: /\bmessages\.stream\b/, label: 'messages.stream (no streaming surface)' },
  { re: /\bstream\s*:\s*true\b/, label: 'stream: true (no streaming surface)' },
  { re: /\btools\b/, label: 'tools (no tool-calling surface)' },
  { re: /\btool_choice\b/, label: 'tool_choice (no tool-calling surface)' },
  { re: /\btool_use\b/, label: 'tool_use (no tool-calling surface)' },
  { re: /\btool_result\b/, label: 'tool_result (no tool-calling surface)' },
  { re: /\bfs\.writeFile/, label: 'fs.writeFile* (no filesystem writes)' },
  { re: /\bfs\.appendFile/, label: 'fs.appendFile* (no filesystem writes)' },
  { re: /\bfs\.createWriteStream\b/, label: 'fs.createWriteStream (no filesystem writes)' },
  { re: /\bfs\.mkdir/, label: 'fs.mkdir* (no filesystem writes)' },
  { re: /\bfs\.rm/, label: 'fs.rm* (no filesystem writes)' },
  { re: /\bfs\.unlink/, label: 'fs.unlink* (no filesystem writes)' },
];

function walk(rel, out) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
  } else if (rel.endsWith('.js')) {
    out.push(rel);
  }
}

function stripComments(content) {
  let out = content.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/\/\/.*$/gm, '');
  return out;
}

function isForbiddenModule(specifier) {
  if (FORBIDDEN_MODULE_EXACT.has(specifier)) return true;
  for (const prefix of FORBIDDEN_MODULE_PREFIXES) {
    if (specifier.startsWith(prefix)) return true;
  }
  return false;
}

function isForbiddenPathSpecifier(specifier) {
  for (const prefix of FORBIDDEN_PATH_PREFIXES) {
    if (specifier === prefix || specifier.startsWith(prefix + '/')) return true;
  }
  return false;
}

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(raw);

  // 1. No SQL keywords.
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 2, 5, 6. Identifier scans.
  for (const { re, label } of FORBIDDEN_IDENTIFIERS) {
    if (re.test(code)) {
      errors.push(`${rel}: forbidden identifier — ${label}`);
    }
  }

  // 3, 4. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
      continue;
    }
    if (isForbiddenPathSpecifier(specifier)) {
      errors.push(
        `${rel}: forbidden cross-layer import "${specifier}" — governance must remain a leaf with no imports from other src/ layers`
      );
    }
  }
}

console.log('Baseline CI — governance boundary');
console.log('---------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — governance boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — governance boundary satisfied.');
