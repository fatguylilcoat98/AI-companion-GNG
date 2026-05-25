#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — gauntlet boundary (GM-30).
 *
 * Mechanically enforces the contract documented in
 * docs/governance/gauntlet-harness.md for src/gauntlet/.
 *
 * The gauntlet is test-only adversarial harness. Per OQ-30.10(a) +
 * constitutional addendum 2 + addendum 3, it is mechanically
 * forbidden from:
 *
 *   1. Any SQL keyword in code (INSERT, UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE, SELECT, FROM,
 *      JOIN, WHERE). The harness goes through src/review/ ctx;
 *      raw SQL must never appear here.
 *   2. The identifier `insertPrivateMemory`.
 *   3. An import of pg (must go through src/review/ ctx).
 *   4. An import of a model SDK (openai, anthropic,
 *      @anthropic-ai/sdk, @openai/*, @anthropic-ai/*).
 *   5. An import of an HTTP/server framework.
 *   6. An import of any internal repository / transaction /
 *      client module from src/review/, src/memory/, or src/db/
 *      — only the top-level public entries are allowed.
 *   7. An import that reaches into runtime/, db/, setup/,
 *      memory/, companion/, conversation/ internals.
 *   8. The L24 bare-identifier forbidden vocabulary
 *      (bypass / skip / disable / override / force /
 *      monkeypatch / monkey_patch).
 *   9. fs write API surface (writeFile, appendFile,
 *      createWriteStream, mkdir, rm, unlink) — the harness
 *      reads scenario JSON only.
 *  10. Scheduling identifiers (setInterval, setImmediate,
 *      cron, schedule) and worker_threads / cluster /
 *      child_process.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own
 * source is not scanned (it necessarily contains the keywords
 * and identifiers it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/gauntlet'];

const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|SELECT|FROM|JOIN|WHERE)\b/g;

const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN_MODULE_EXACT = new Set([
  'pg',
  'openai',
  'anthropic',
  '@anthropic-ai/sdk',
  'http',
  'https',
  'express',
  'fastify',
  'koa',
  '@hapi/hapi',
  'child_process',
  'worker_threads',
  'cluster',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

// Only the public entries of the three allowed dependencies.
const ALLOWED_REL_EXACT = new Set([
  '../governance',
  '../governance/index',
  '../actors',
  '../actors/index',
  '../review',
  '../review/index',
  // Sibling files within src/gauntlet/ are obviously allowed.
]);

// Anything reaching into internal modules of other src/ layers
// is forbidden.
const FORBIDDEN_DEEP_PATHS = [
  /^\.\.\/review\/.+/,
  /^\.\.\/governance\/.+/,
  /^\.\.\/actors\/.+/,
  /^\.\.\/memory(\/.*)?$/,
  /^\.\.\/runtime(\/.*)?$/,
  /^\.\.\/db(\/.*)?$/,
  /^\.\.\/setup(\/.*)?$/,
  /^\.\.\/companion(\/.*)?$/,
  /^\.\.\/conversation(\/.*)?$/,
];

const FORBIDDEN_IDENTIFIER = /\binsertPrivateMemory\b/g;

// L24 word list — per OQ-30.10(a). The actor's structural
// guarantee is that the gauntlet TESTS the substrate; it does
// not bypass / skip / disable / override / force anything, and
// it does not monkeypatch the modules it consumes.
const L24_FORBIDDEN = [
  'bypass', 'skip', 'disable', 'override', 'force',
  'monkeypatch', 'monkey_patch',
];

// fs write API surface.
const FS_WRITE_RE = /\bfs\.(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\b/g;

// Scheduling.
const SCHED_RE = /\b(setInterval|setImmediate|cron|schedule)\b/g;

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

function isAllowedRelative(specifier) {
  if (!specifier.startsWith('.')) return null; // not a relative import; let the module-exact check handle it
  if (specifier.startsWith('./')) return true; // sibling file in src/gauntlet/
  if (ALLOWED_REL_EXACT.has(specifier)) return true;
  for (const re of FORBIDDEN_DEEP_PATHS) {
    if (re.test(specifier)) return false;
  }
  // Default-deny for any other ../ specifier.
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

  // 2. No insertPrivateMemory.
  if (FORBIDDEN_IDENTIFIER.test(code)) {
    errors.push(`${rel}: forbidden identifier "insertPrivateMemory"`);
  }

  // 3, 4, 5, 6, 7. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
      continue;
    }
    if (specifier.startsWith('.')) {
      const allowed = isAllowedRelative(specifier);
      if (allowed === false) {
        errors.push(
          `${rel}: forbidden relative import "${specifier}" — allowed: sibling files, "../governance", "../actors", "../review"`
        );
      }
    }
  }

  // 8. L24 forbidden vocabulary.
  for (const w of L24_FORBIDDEN) {
    if (new RegExp('\\b' + w + '\\b').test(code)) {
      errors.push(`${rel}: forbidden bare identifier "${w}" (L24)`);
    }
  }

  // 9. fs write API.
  const fsMatches = code.match(FS_WRITE_RE);
  if (fsMatches) {
    errors.push(`${rel}: forbidden fs write API: ${Array.from(new Set(fsMatches)).join(', ')}`);
  }

  // 10. Scheduling.
  const schedMatches = code.match(SCHED_RE);
  if (schedMatches) {
    errors.push(`${rel}: forbidden scheduling identifier: ${Array.from(new Set(schedMatches)).join(', ')}`);
  }
}

console.log('Baseline CI — gauntlet boundary');
console.log('-------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — gauntlet boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — gauntlet boundary satisfied.');
