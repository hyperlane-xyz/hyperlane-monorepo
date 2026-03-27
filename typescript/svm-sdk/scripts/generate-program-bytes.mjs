#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeSealevelSourceHash } from './sealevel-source-hash.mjs';
import crossCollateralFallbackBytes from './cross-collateral-program-bytes.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROGRAMS_DIR = join(__dirname, '../../../rust/sealevel/target/deploy');
const OUTPUT_FILE = join(__dirname, '../src/hyperlane/program-bytes.ts');

/** All Sealevel programs — keys match PROGRAM_BINARIES in testing/setup.ts. */
const PROGRAMS = {
  mailbox: 'hyperlane_sealevel_mailbox.so',
  igp: 'hyperlane_sealevel_igp.so',
  multisigIsm: 'hyperlane_sealevel_multisig_ism_message_id.so',
  testIsm: 'hyperlane_sealevel_test_ism.so',
  validatorAnnounce: 'hyperlane_sealevel_validator_announce.so',
  tokenSynthetic: 'hyperlane_sealevel_token.so',
  tokenNative: 'hyperlane_sealevel_token_native.so',
  tokenCollateral: 'hyperlane_sealevel_token_collateral.so',
  tokenCrossCollateral: 'hyperlane_sealevel_token_cross_collateral.so',
};

/** Fallback bytes for programs whose .so is not yet available locally. */
const FALLBACK_BYTES = {
  tokenCrossCollateral: crossCollateralFallbackBytes,
};

console.log('🔧 Generating program bytes from .so files...\n');

const programBytes = {};

for (const [key, filename] of Object.entries(PROGRAMS)) {
  const path = join(PROGRAMS_DIR, filename);
  try {
    const bytes = readFileSync(path);
    programBytes[key] = Array.from(bytes);
    console.log(`  ✅ ${key}: ${bytes.length.toLocaleString()} bytes`);
  } catch {
    const fallback = FALLBACK_BYTES[key];
    if (fallback) {
      programBytes[key] = Array.from(fallback);
      console.log(`  ⚠️  ${key}: using fallback bytes (${fallback.length.toLocaleString()} bytes)`);
    } else {
      console.error(`  ❌ ${key}: required .so file not found at ${path}`);
      process.exit(1);
    }
  }
}

const sourceHash = computeSealevelSourceHash();
console.log(`\n  Source hash: ${sourceHash}`);

const entries = Object.entries(programBytes)
  .map(([key, bytes]) => `  ${key}: new Uint8Array([${bytes}]),`)
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
console.log(`\n✨ Generated ${OUTPUT_FILE}\n`);
