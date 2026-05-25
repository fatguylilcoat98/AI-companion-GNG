#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — runtime boundary.
 *
 * Hardens the runtime configuration-loader boundary by mechanically
 * enforcing what was previously human-reviewed in src/runtime/ and
 * src/db/.
 *
 * Fails the build on:
 *   1. a forbidden SQL keyword in code (INSERT, UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE) — comments excluded
 *   2. a FROM/JOIN clause referencing a table outside the locked
 *      configuration-read allowlist
 *   3. an import of a model SDK (openai, anthropic, @anthropic-ai/sdk,
 *      @openai/*)
 *   4. an import of pg from anywhere other than src/db/client.js
 *
 * See docs/governance/runtime-boundary.md.
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source is
 * not scanned (it necessarily contains the keywords and table names it
 * detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/runtime', 'src/db'];

// The single file permitted to import pg.
const PG_ALLOWED_PATH = 'src/db/client.js';

// The runtime configuration-loader read allowlist (GM-7b contract).
const ALLOWED_TABLES = new Set([
  'pilot_instances',
  'companion_profile',
  'supported_person_profile',
  'setup_state',
]);

// Forbidden SQL keywords. Matched case-sensitively (SQL keywords in
// the codebase are uppercase; lowercase identifiers like createPool,
// updateState, deleteEntry would never match).
const FORBIDDEN_SQL = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

// Tables referenced by SELECT statements. Case-insensitive so the
// scanner catches both `FROM table` and `from table` (the latter does
// not occur in our codebase but is included for robustness).
const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

// Import detection — CommonJS require() form, which is what this
// codebase uses.
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

// Forbidden module specifiers (exact matches and prefixes).
const FORBIDDEN_MODULE_EXACT = new Set(['openai', 'anthropic', '@anthropic-ai/sdk']);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

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

// Remove block and line comments so the scanner does not match keywords
// or table names that appear only in commentary.
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

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(raw);

  // 1. Forbidden SQL keywords.
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 2. FROM/JOIN tables must be in the allowlist.
  for (const m of code.matchAll(FROM_JOIN)) {
    const table = m[1].toLowerCase();
    if (!ALLOWED_TABLES.has(table)) {
      errors.push(`${rel}: FROM/JOIN references non-allowlisted table "${m[1]}"`);
    }
  }

  // 3 + 4. Forbidden imports and pg-scoping.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
    }
    if (specifier === 'pg' && rel !== PG_ALLOWED_PATH) {
      errors.push(`${rel}: pg may only be imported from ${PG_ALLOWED_PATH}`);
    }
    // 5. The gauntlet (GM-30) is test-only; runtime / db must
    //    never import it. Enforces OQ-30.12 reciprocity.
    if (specifier === '../gauntlet' || specifier === '../gauntlet/index' || /^\.\.\/gauntlet\//.test(specifier)) {
      errors.push(`${rel}: forbidden import "${specifier}" — src/gauntlet/ is test-only and must never be imported by runtime/db code (GM-30)`);
    }
  }
}

console.log('Baseline CI — runtime boundary');
console.log('------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — runtime boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — runtime boundary satisfied.');
