#!/usr/bin/env node
'use strict';
/*
 * Baseline CI guard — secret / env-file guard.
 *
 * Hard-fails the build when:
 *   1. a tracked .env or .env.* file exists, other than .env.example
 *   2. .env.example contains a non-empty, non-placeholder value
 *   3. a tracked text file contains a secret-shaped token
 *
 * The master template must never carry secrets. .env.example holds
 * placeholder variable names only.
 *
 * This guard's own source is excluded from the token scan (it necessarily
 * contains the detection patterns).
 */

const fs = require('fs');
const path = require('path');

const REPO = process.cwd();

const SAFE_ENV_VALUES = new Set([
  '', 'true', 'false', 'development', 'production', 'test',
]);

const SECRET_PATTERNS = [
  { name: 'private-key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Anthropic-style key', re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { name: 'provider key prefix', re: /sk-[A-Za-z0-9]{24,}/ },
  { name: 'AWS access key id', re: /AKIA[0-9A-Z]{16}/ },
  { name: 'JSON web token', re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./ },
];

const TEXT_EXT = /\.(js|cjs|mjs|ts|ya?ml|json|md|sh|sql|txt|example)$/;

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

// 1. No stray environment files.
for (const f of all) {
  const base = path.basename(f);
  if (base === '.env.example') continue;
  if (base === '.env' || base.startsWith('.env.')) {
    errors.push(`tracked environment file is forbidden: ${f} (only .env.example may be committed)`);
  }
}

// 2. .env.example carries placeholder values only.
if (all.includes('.env.example')) {
  const lines = fs.readFileSync(path.join(REPO, '.env.example'), 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const value = trimmed.slice(eq + 1).trim();
    if (!SAFE_ENV_VALUES.has(value)) {
      errors.push(`.env.example:${i + 1}: non-placeholder value "${value}" — .env.example must hold blank placeholders only`);
    }
  });
}

// 3. No secret-shaped tokens in tracked text files. The guard scripts are
//    excluded — they legitimately contain the detection patterns.
for (const f of all) {
  if (f.startsWith('scripts/ci/')) continue;
  if (!TEXT_EXT.test(f)) continue;
  const content = fs.readFileSync(path.join(REPO, f), 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(content)) {
      errors.push(`${f}: contains a ${pattern.name} — secrets must never be committed`);
    }
  }
}

console.log('Baseline CI — secret / env-file guard');
console.log('-------------------------------------');
console.log(`Files scanned: ${all.length}`);
if (errors.length) {
  console.log('');
  console.log('FAIL — secret / env-file violations:');
  for (const e of errors) console.log(`  - ${e}`);
  process.exit(1);
}
console.log('OK — no secrets or stray environment files.');
