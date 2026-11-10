#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSealevelSourceHash } from './sealevel-source-hash.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROGRAMS_DIR = join(__dirname, '../../../rust/sealevel/target/deploy');
const OUTPUT_FILE = join(__dirname, '../src/hyperlane/program-bytes.ts');
const METADATA_OUTPUT_FILE = join(
  __dirname,
  '../src/hyperlane/program-metadata.ts',
);

import { PROGRAMS } from './programs.mjs';

console.log('🔧 Generating program bytes from .so files...\n');

const programBytes = {};
const programMetadata = {};

for (const [key, filename] of Object.entries(PROGRAMS)) {
  const path = join(PROGRAMS_DIR, filename);
  try {
    const bytes = readFileSync(path);
    programBytes[key] = Array.from(bytes);
    programMetadata[key] = {
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    console.log(`  ✅ ${key}: ${bytes.length.toLocaleString()} bytes`);
  } catch {
    console.error(`  ❌ ${key}: required .so file not found at ${path}`);
    process.exit(1);
  }
}

const sourceHash = computeSealevelSourceHash();
console.log(`\n  Source hash: ${sourceHash}`);

const entries = Object.entries(programBytes)
  .map(([key, bytes]) => `  ${key}: new Uint8Array([${bytes}]),`)
  .join('\n');

const metadataEntries = Object.entries(programMetadata)
  .map(
    ([key, { byteLength, sha256 }]) => `  ${key}: {
    byteLength: ${byteLength},
    sha256: '${sha256}',
  },`,
  )
  .join('\n');

const tsContent = `/**
 * Auto-generated program bytes from compiled .so binaries.
 * DO NOT EDIT — regenerate with:
 *   pnpm -C typescript/svm-sdk program:build
 *   pnpm -C typescript/svm-sdk program:generate
 */

/** SHA-256 of Rust sealevel sources at generation time. Used for CI staleness detection. */
export const SEALEVEL_SOURCE_HASH = '${sourceHash}';

export const HYPERLANE_SVM_PROGRAM_BYTES = {
${entries}
} as const;

export type HyperlaneSvmProgramBytesKey = keyof typeof HYPERLANE_SVM_PROGRAM_BYTES;
`;

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, tsContent);

const metadataContent = `/**
 * Auto-generated SHA-256 hashes and byte lengths for the compiled .so binaries
 * embedded by this package.
 * DO NOT EDIT — regenerate with:
 *   pnpm -C typescript/svm-sdk program:build
 *   pnpm -C typescript/svm-sdk program:generate
 */

export const HYPERLANE_SVM_PROGRAM_METADATA = {
${metadataEntries}
} as const;

export type HyperlaneSvmProgramMetadataKey =
  keyof typeof HYPERLANE_SVM_PROGRAM_METADATA;
`;

writeFileSync(METADATA_OUTPUT_FILE, metadataContent);
console.log(`\n✨ Generated ${OUTPUT_FILE}`);
console.log(`✨ Generated ${METADATA_OUTPUT_FILE}\n`);
