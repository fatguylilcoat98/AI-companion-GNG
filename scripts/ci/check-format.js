#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — formatting.
 *
 * Checks each in-scope text file:
 *   - ends with exactly one newline
 *   - contains no trailing whitespace
 *   - (for *.test.js) contains no focused tests (".only(")
 *
 * Scope: the authored surface of the master template.
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();
const SCAN = ['.github', 'scripts', 'tests', 'docs'];
const TEXT_EXT = /\.(js|cjs|mjs|ya?ml|json|md|sh)$/;

function collect(rel, out) {
  const abs = path.join(REPO, rel);
  if (!fs.existsSync(abs)) return;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs)) collect(`${rel}/${name}`, out);
  } else if (TEXT_EXT.test(rel)) {
    out.push(rel);
  }
}

const files = [];
for (const target of SCAN) collect(target, files);

const errors = [];
for (const rel of files) {
  const content = fs.readFileSync(path.join(REPO, rel), 'utf8');
  if (content.length === 0) {
    errors.push(`${rel}: file is empty`);
    continue;
  }
  if (!content.endsWith('\n')) {
    errors.push(`${rel}: missing final newline`);
  }
  if (content.endsWith('\n\n')) {
    errors.push(`${rel}: more than one trailing newline`);
  }
  content.split('\n').forEach((line, i) => {
    if (/[ \t]+$/.test(line)) {
      errors.push(`${rel}:${i + 1}: trailing whitespace`);
    }
  });
  if (rel.endsWith('.test.js') && content.includes('.only(')) {
    errors.push(`${rel}: focused test (".only(") must not be committed`);
  }
}

console.log('Baseline CI — formatting');
console.log('------------------------');
console.log(`Files checked: ${files.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — formatting issues:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — no formatting issues.');
