#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — no archived SQL guard.
 *
 * The master template starts a clean migration chain. No historical or
 * archived SQL is carried over from any reference system.
 *
 * Hard-fails the build when any path contains an `_archive` component.
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.relative(REPO, path.join(dir, entry.name)).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      walk(path.join(dir, entry.name), out);
    } else {
      out.push(rel);
    }
  }
}

const all = [];
walk(REPO, all);
const errors = [];

for (const f of all) {
  if (f.split('/').includes('_archive')) {
    errors.push(`archived path is forbidden in the master template: ${f}`);
  }
}

console.log('Baseline CI — no archived SQL guard');
console.log('-----------------------------------');
console.log(`Files scanned: ${all.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — archived SQL violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — no archived SQL present.');
