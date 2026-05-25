#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — review boundary (GM-23 + GM-24 + GM-25).
 *
 * Mechanically enforces the contracts documented in
 * docs/governance/review-queue-runtime-boundary.md,
 * docs/governance/review-decision-runtime-boundary.md, AND
 * docs/governance/execution-authorization-runtime-boundary.md
 * for src/review/.
 *
 * As of GM-25 the review module touches three tables
 * (governance_review_queue + governance_review_decisions +
 * governance_execution_authorizations). All three are append-only
 * at the DB layer; the module has no UPDATE/DELETE responsibilities.
 *
 * Fails the build on:
 *   1. A forbidden write/DDL SQL keyword (UPDATE, DELETE, DROP,
 *      ALTER, TRUNCATE, GRANT, REVOKE, CREATE — append-only
 *      semantics; INSERT permitted but tracked separately).
 *   2. A FROM/JOIN clause referencing a table outside the review-
 *      module read allowlist (governance_review_queue,
 *      governance_review_decisions,
 *      governance_execution_authorizations, users, pilot_instances).
 *   3. An INSERT INTO targeting any table other than the three
 *      append-only governance artifacts above.
 *   4. An import of pg outside src/review/client.js.
 *   5. An import of a model SDK (any).
 *   6. An import of an HTTP/server framework (http, https, express,
 *      fastify, koa, @hapi/hapi).
 *   7. An import of child_process, worker_threads, or cluster.
 *   8. A scheduling identifier: setInterval, setImmediate, cron,
 *      schedule. (setTimeout is permitted — the pg pool uses it
 *      internally for timeouts; the review module code itself
 *      does not call it.)
 *   9. A filesystem-write API: fs.writeFile*, fs.appendFile*,
 *      fs.createWriteStream, fs.mkdir*, fs.rm*, fs.unlink*.
 *  10. The identifier `insertPrivateMemory` (defense in depth —
 *      the review module does not write memory).
 *  11. A streaming or tool-calling identifier (defense in depth).
 *
 * The guard scans only .js files under SCAN_ROOTS. Its own source
 * is not scanned (it necessarily contains the keywords and
 * identifiers it detects).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN_ROOTS = ['src/review'];

const PG_ALLOWED_PATH = 'src/review/client.js';

const SELECT_ALLOWED_TABLES = new Set([
  'governance_review_queue',
  'governance_review_decisions',
  'governance_execution_authorizations',
  'governance_execution_claims',
  'governance_execution_attempts',
  'governance_execution_outcomes',
  'governance_execution_verifications',
  'users',
  'pilot_instances',
]);

const INSERT_ALLOWED_TABLES = new Set([
  'governance_review_queue',
  'governance_review_decisions',
  'governance_execution_authorizations',
  'governance_execution_claims',
  'governance_execution_attempts',
  'governance_execution_outcomes',
  'governance_execution_verifications',
]);

// All write/DDL keywords except INSERT (which is permitted but
// tracked via INSERT_INTO separately).
const FORBIDDEN_SQL = /\b(UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE)\b/g;

const FROM_JOIN = /\b(?:FROM|JOIN)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
const INSERT_INTO = /\bINSERT\s+INTO\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const FORBIDDEN_MODULE_EXACT = new Set([
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
  '@anthropic-ai/sdk',
  'openai',
  'anthropic',
]);
const FORBIDDEN_MODULE_PREFIXES = ['@anthropic-ai/', '@openai/'];

const FORBIDDEN_IDENTIFIERS = [
  { re: /\binsertPrivateMemory\b/, label: 'insertPrivateMemory (no memory-write op)' },
  { re: /\bsetInterval\b/, label: 'setInterval (no scheduling)' },
  { re: /\bsetImmediate\b/, label: 'setImmediate (no scheduling)' },
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

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  const raw = fs.readFileSync(path.join(REPO, rel), 'utf8');
  const code = stripComments(raw);

  // 1. No write/DDL SQL keywords (INSERT tracked separately).
  const sqlMatches = code.match(FORBIDDEN_SQL);
  if (sqlMatches) {
    const unique = Array.from(new Set(sqlMatches)).sort();
    errors.push(`${rel}: forbidden SQL keyword(s) in code: ${unique.join(', ')}`);
  }

  // 8, 9, 10, 11. Identifier scans.
  for (const { re, label } of FORBIDDEN_IDENTIFIERS) {
    if (re.test(code)) {
      errors.push(`${rel}: forbidden identifier — ${label}`);
    }
  }

  // 2. FROM/JOIN allowlist.
  for (const m of code.matchAll(FROM_JOIN)) {
    const table = m[1].toLowerCase();
    if (!SELECT_ALLOWED_TABLES.has(table)) {
      errors.push(`${rel}: FROM/JOIN references non-allowlisted table "${m[1]}"`);
    }
  }

  // 3. INSERT INTO allowlist.
  for (const m of code.matchAll(INSERT_INTO)) {
    const table = m[1].toLowerCase();
    if (!INSERT_ALLOWED_TABLES.has(table)) {
      errors.push(
        `${rel}: INSERT INTO references non-allowlisted table "${m[1]}" `
          + `(allowed: ${Array.from(INSERT_ALLOWED_TABLES).join(', ')})`
      );
    }
  }

  // 4, 5, 6, 7. Import discipline.
  for (const m of code.matchAll(REQUIRE)) {
    const specifier = m[1];
    if (isForbiddenModule(specifier)) {
      errors.push(`${rel}: forbidden module import "${specifier}"`);
    }
    if (specifier === 'pg' && rel !== PG_ALLOWED_PATH) {
      errors.push(`${rel}: pg may only be imported from ${PG_ALLOWED_PATH}`);
    }
    // 8. The gauntlet (GM-30) is test-only; review must never
    //    import it. Enforces OQ-30.12 reciprocity.
    if (specifier === '../gauntlet' || specifier === '../gauntlet/index' || /^\.\.\/gauntlet\//.test(specifier)) {
      errors.push(`${rel}: forbidden import "${specifier}" — src/gauntlet/ is test-only (GM-30)`);
    }
  }
}

// ---------------------------------------------------------------------
// File-scoped forbidden-vocabulary scans (GM-26 OQ-26.14 +
// GM-27 OQ-27.14 / OQ-27.17). Specific ledger-actor files are
// mechanically forbidden from containing operational vocabulary.
//
// Each scan is file-scoped because these identifiers appear
// legitimately elsewhere (e.g. response-delivery-actor's
// 'executed' outcome, the OUTCOMES doc comment, repository-layer
// SQL strings). Adding them to the module-wide
// FORBIDDEN_IDENTIFIERS would false-positive.
//
// Shared helper (per OQ-27.17): runFileScopedForbiddenScan applies
// a forbidden-identifier list to one specific file. Used for the
// GM-26 execution-claim ledger and the GM-27 execution-attempt
// ledger; future ledger actors can register their own scan by
// adding to FILE_SCOPED_SCANS below.
// ---------------------------------------------------------------------

function runFileScopedForbiddenScan(relPath, forbidden, errorsOut) {
  const abs = path.join(REPO, relPath);
  if (!fs.existsSync(abs)) return;
  const raw = fs.readFileSync(abs, 'utf8');
  const code = stripComments(raw);
  for (const { re, label } of forbidden) {
    if (re.test(code)) {
      errorsOut.push(`${relPath}: forbidden operational identifier — ${label}`);
    }
  }
}

const FILE_SCOPED_SCANS = [
  // GM-26: execution-claim ledger actor. "Claim is NOT execution;
  // claim is NOT dispatch; claim is NOT completion; claim is NOT
  // success." Per OQ-26.14.
  {
    file: 'src/actors/execution-claim-ledger-actor.js',
    forbidden: [
      { re: /\bexecuted\b/, label: 'executed (claim is NOT execution)' },
      { re: /\bcompleted\b/, label: 'completed (claim is NOT completion)' },
      { re: /\bdispatched\b/, label: 'dispatched (claim is NOT dispatch)' },
      { re: /\bdelivered\b/, label: 'delivered (claim is NOT delivery)' },
      { re: /\bfinalized\b/, label: 'finalized (claim is NOT finalization)' },
      { re: /\bsucceeded\b/, label: 'succeeded (claim is NOT success)' },
      { re: /\bfailed\b/, label: 'failed (claim records single-consumption, not outcome)' },
    ],
  },
  // GM-27: execution-attempt ledger actor. "ATTEMPT IS NOT
  // OUTCOME." Per OQ-27.14. Same word list as the claim ledger
  // PLUS `committed` (which reads as outcome semantics most
  // strongly at this layer; the database-level commit lives in
  // the transaction layer, never in the actor file).
  {
    file: 'src/actors/execution-attempt-ledger-actor.js',
    forbidden: [
      { re: /\bexecuted\b/, label: 'executed (ATTEMPT IS NOT OUTCOME)' },
      { re: /\bcompleted\b/, label: 'completed (attempt is NOT completion)' },
      { re: /\bdispatched\b/, label: 'dispatched (attempt is NOT dispatch)' },
      { re: /\bdelivered\b/, label: 'delivered (attempt is NOT delivery)' },
      { re: /\bfinalized\b/, label: 'finalized (attempt is NOT finalization)' },
      { re: /\bsucceeded\b/, label: 'succeeded (attempt is NOT success)' },
      { re: /\bfailed\b/, label: 'failed (attempt records beginning, not outcome)' },
      { re: /\bcommitted\b/, label: 'committed (DB commit lives in the transaction layer, NOT in this actor)' },
    ],
  },
  // GM-28: execution-outcome ledger actor. "AN OUTCOME ROW IS
  // NOT TRUTH." Per OQ-28.14. The STRICTEST file-scoped scan in
  // the entire substrate. Combines GM-27's 8 outcome-implying
  // words with 10 NEW truth-claim words. The actor file records
  // a *reported* observation; it must contain no operational
  // vocabulary AND no truth-claim vocabulary.
  {
    file: 'src/actors/execution-outcome-ledger-actor.js',
    forbidden: [
      // GM-27 inheritance: outcome-implying vocabulary.
      { re: /\bexecuted\b/, label: 'executed (outcome row is NOT execution)' },
      { re: /\bcompleted\b/, label: 'completed (outcome row is NOT completion — it is reported completion)' },
      { re: /\bdispatched\b/, label: 'dispatched (outcome row is NOT dispatch)' },
      { re: /\bdelivered\b/, label: 'delivered (outcome row is NOT delivery)' },
      { re: /\bfinalized\b/, label: 'finalized (outcome row is NOT finalization)' },
      { re: /\bsucceeded\b/, label: 'succeeded (outcome row is NOT success — would smuggle truth claim)' },
      { re: /\bfailed\b/, label: 'failed (outcome row is NOT failure — would smuggle truth claim)' },
      { re: /\bcommitted\b/, label: 'committed (DB commit lives in the transaction layer)' },
      // GM-28 NEW: truth-claim vocabulary. AN OUTCOME ROW IS
      // NOT TRUTH.
      { re: /\bverified\b/, label: 'verified (verification is a SEPARATE future ring)' },
      { re: /\bconfirmed\b/, label: 'confirmed (outcome row is NOT confirmation)' },
      { re: /\bactual\b/, label: 'actual (outcome row is NOT the actual state)' },
      { re: /\bactually\b/, label: 'actually (outcome row is reported, not actual)' },
      { re: /\bdefinitely\b/, label: 'definitely (outcome row is NOT a definitive claim)' },
      { re: /\bproven\b/, label: 'proven (outcome row is NOT proof)' },
      { re: /\bcertain\b/, label: 'certain (outcome row is NOT certainty)' },
      { re: /\breal\b/, label: 'real (outcome row is NOT a claim about real state)' },
      { re: /\breality\b/, label: 'reality (outcome row is NOT reality)' },
      { re: /\btruth\b/, label: 'truth (AN OUTCOME ROW IS NOT TRUTH)' },
    ],
  },
  // GM-29: execution-verification ledger actor. "VERIFICATION ≠
  // RECONCILIATION ≠ REPAIR." Per OQ-29.10(b), modified by the
  // owner-noted exception that bare `execute` and `dispatch` are
  // dropped (they would collide with the actor contract method
  // name); past-tense `executed` and `dispatched` are retained.
  // 20 words total: 12 operational/repair words + 8 fix-it
  // temptation words. K24 is the third file-scoped scan; the
  // verification-ledger actor records observations through named
  // evidence channels and must contain none of these as bare
  // identifiers.
  {
    file: 'src/actors/execution-verification-ledger-actor.js',
    forbidden: [
      // Operational / repair vocabulary (12).
      { re: /\bexecuted\b/, label: 'executed (verification is NOT execution)' },
      { re: /\bdispatched\b/, label: 'dispatched (verification is NOT dispatch)' },
      { re: /\bretry\b/, label: 'retry (VERIFICATION ≠ RETRY)' },
      { re: /\bretried\b/, label: 'retried (verification is NOT a retry)' },
      { re: /\breconcile\b/, label: 'reconcile (VERIFICATION ≠ RECONCILIATION)' },
      { re: /\breconciled\b/, label: 'reconciled (verification is NOT reconciliation)' },
      { re: /\brollback\b/, label: 'rollback (verification is NOT rollback)' },
      { re: /\bcompensate\b/, label: 'compensate (verification is NOT compensation)' },
      { re: /\bside_effect\b/, label: 'side_effect (verification has NO side effects)' },
      { re: /\bmutate\b/, label: 'mutate (verification mutates NOTHING)' },
      { re: /\bpromote\b/, label: 'promote (verification does NOT promote anything)' },
      { re: /\badmit\b/, label: 'admit (verification does NOT admit anything to a downstream surface)' },
      // Fix-it temptation vocabulary (8).
      { re: /\bfix\b/, label: 'fix (VERIFICATION ≠ REPAIR)' },
      { re: /\brepair\b/, label: 'repair (VERIFICATION ≠ REPAIR)' },
      { re: /\bcorrect\b/, label: 'correct (verification does NOT correct anything)' },
      { re: /\bheal\b/, label: 'heal (verification does NOT heal)' },
      { re: /\bresolve\b/, label: 'resolve (verification does NOT resolve disputes)' },
      { re: /\brevert\b/, label: 'revert (verification does NOT revert)' },
      { re: /\bundo\b/, label: 'undo (verification does NOT undo)' },
      { re: /\bapply\b/, label: 'apply (verification does NOT apply a change)' },
    ],
  },
];

for (const { file, forbidden } of FILE_SCOPED_SCANS) {
  runFileScopedForbiddenScan(file, forbidden, errors);
}

console.log('Baseline CI — review-queue boundary');
console.log('-----------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — review-queue boundary violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — review-queue boundary satisfied.');
