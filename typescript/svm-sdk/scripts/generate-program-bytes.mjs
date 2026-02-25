#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROGRAMS_DIR = join(
  __dirname,
  '../../../rust/sealevel/target/deploy',
);
const OUTPUT_FILE = join(__dirname, '../src/hyperlane/program-bytes.ts');

/** All Sealevel programs — keys match PROGRAM_BINARIES in testing/setup.ts. */
const PROGRAMS = {
  mailbox: 'hyperlane_sealevel_mailbox.so',
  igp: 'hyperlane_sealevel_igp.so',
  multisigIsm: 'hyperlane_sealevel_multisig_ism_message_id.so',
  testIsm: 'hyperlane_sealevel_test_ism.so',
  validatorAnnounce: 'hyperlane_sealevel_validator_announce.so',
  token: 'hyperlane_sealevel_token.so',
  tokenNative: 'hyperlane_sealevel_token_native.so',
  tokenCollateral: 'hyperlane_sealevel_token_collateral.so',
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
    console.warn(`  ⚠️  ${key}: not found — will be empty Uint8Array`);
    programBytes[key] = [];
  }
}

const entries = Object.entries(programBytes)
  .map(([key, bytes]) => `  ${key}: new Uint8Array([${bytes}]),`)
  .join('\n');

const tsContent = `/**
 * Auto-generated program bytes from compiled .so binaries.
 * DO NOT EDIT — regenerate with: pnpm program:generate
 *
 * Generated: ${new Date().toISOString()}
 */

export const PROGRAM_BYTES = {
${entries}
} as const;

export type ProgramBytesKey = keyof typeof PROGRAM_BYTES;
`;

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, tsContent);
console.log(`\n✨ Generated ${OUTPUT_FILE}\n`);
