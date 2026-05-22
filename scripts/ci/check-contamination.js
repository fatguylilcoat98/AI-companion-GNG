#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — contamination scanner.
 *
 * The master template is extracted from the lessons of the Mattie
 * reference system, never from its data or its one-off persona. This
 * guard hard-fails the build when a known reference-system identifier
 * appears in a must-be-clean root.
 *
 * Denylist: known reference-system identifiers only. Real family or
 * private names are deliberately NOT listed — a denylist holding real
 * names would itself be a leak. Semantic contamination (a generic-
 * looking value that is secretly an instance assumption) is review-only.
 *
 * Scope: config/ and executable source roots. docs/ is excluded — the
 * governance docs legitimately name these identifiers in their
 * contamination watchlists. This guard's own source is excluded too,
 * since it necessarily contains the denylist.
 *
 * As executable application code is extracted in later PRs, each new
 * source root is added to SCAN_ROOTS so scanning grows with the code.
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();

// Must-be-clean roots. Extend this as executable code roots are added.
const SCAN_ROOTS = ['config', 'scripts/validate'];

// This guard's own file — excluded so the denylist does not match itself.
const SELF = 'scripts/ci/check-contamination.js';

// Known reference-system identifiers. Case-insensitive substring match.
const DENYLIST = ['mattie', 'sandy', 'mattie_soul'];

const TEXT_EXT = /\.(js|cjs|mjs|ts|ya?ml|json|md|sh|sql|txt|example)$/;

function walk(rel, out) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    if (rel.endsWith('/node_modules') || rel.endsWith('/.git')) return;
    for (const name of fs.readdirSync(abs)) walk(`${rel}/${name}`, out);
  } else if (TEXT_EXT.test(rel)) {
    out.push(rel);
  }
}

const files = [];
for (const root of SCAN_ROOTS) walk(root, files);

const errors = [];
for (const rel of files) {
  if (rel === SELF) continue;
  const lower = fs.readFileSync(path.join(REPO, rel), 'utf8').toLowerCase();
  for (const token of DENYLIST) {
    if (lower.includes(token)) {
      errors.push(`${rel}: contains denylisted reference-system identifier "${token}"`);
    }
  }
}

console.log('Baseline CI — contamination scanner');
console.log('-----------------------------------');
console.log(`Scoped roots: ${SCAN_ROOTS.join(', ')}`);
console.log(`Files scanned: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — contamination detected:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — no reference-system contamination in scoped roots.');
