#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSealevelSourceHash } from './sealevel-source-hash.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROGRAM_BYTES_FILE = join(__dirname, '../src/hyperlane/program-bytes.ts');

let content;
try {
  content = readFileSync(PROGRAM_BYTES_FILE, 'utf-8');
} catch {
  console.error(
    'ERROR: program-bytes.ts not found. Regenerate with:\n' +
      '  pnpm -C typescript/svm-sdk program:build\n' +
      '  pnpm -C typescript/svm-sdk program:generate',
  );
  process.exit(1);
}

const match = content.match(/SEALEVEL_SOURCE_HASH\s*=\s*'([a-f0-9]{64})'/);
if (!match) {
  console.error(
    'ERROR: SEALEVEL_SOURCE_HASH not found in program-bytes.ts.\n' +
      'The file may predate the staleness check. Regenerate with:\n' +
      '  pnpm -C typescript/svm-sdk program:build\n' +
      '  pnpm -C typescript/svm-sdk program:generate',
  );
  process.exit(1);
}

const embeddedHash = match[1];
const currentHash = computeSealevelSourceHash();

if (embeddedHash === currentHash) {
  console.log('program-bytes.ts is up to date with Rust sealevel sources.');
  process.exit(0);
}

console.error('ERROR: program-bytes.ts is STALE.');
console.error(`  Embedded hash: ${embeddedHash}`);
console.error(`  Current hash:  ${currentHash}`);
console.error('');
console.error(
  'Rust sealevel sources changed but program-bytes.ts was not regenerated.\n' +
    'To fix:\n' +
    '  pnpm -C typescript/svm-sdk program:build\n' +
    '  pnpm -C typescript/svm-sdk program:generate',
);
process.exit(1);
