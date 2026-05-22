#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — no real-data guard.
 *
 * Hard-fails the build when:
 *   1. a data-export file type is tracked anywhere
 *   2. the seed/ tree contains anything outside seed/demo/
 *
 * The master template carries demo / sample data only, under seed/demo/,
 * and it must be clearly fictional.
 *
 * Limitation: a guard cannot decide whether a given value is "real". This
 * guard enforces the structural rules; the semantic boundary is enforced
 * by docs/setup/template-boundaries.md and by review.
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const DATA_EXPORT_EXT = /\.(csv|tsv|ndjson|parquet|xlsx|xls|dump)$/i;

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
  if (DATA_EXPORT_EXT.test(f)) {
    errors.push(`data-export file is forbidden in the master template: ${f}`);
  }
  if (f.startsWith('seed/') && !f.startsWith('seed/demo/')) {
    errors.push(`seed/ may only contain seed/demo/: ${f}`);
  }
}

console.log('Baseline CI — no real-data guard');
console.log('--------------------------------');
console.log(`Files scanned: ${all.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — real-data guard violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — no data-export files; seed/ is confined to seed/demo/.');
