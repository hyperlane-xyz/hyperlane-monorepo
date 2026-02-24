#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PROGRAMS_DIR = join(__dirname, '../../../rust/sealevel/target/deploy');
const OUTPUT_FILE = join(__dirname, '../src/generated/program-bytes.ts');

const PROGRAMS = {
  nativeToken: 'hyperlane_sealevel_token_native.so',
  syntheticToken: 'hyperlane_sealevel_token.so',
  collateralToken: 'hyperlane_sealevel_token_collateral.so',
};

console.log('🔧 Generating program bytes from .so files...\n');

const programBytes = {};

for (const [key, filename] of Object.entries(PROGRAMS)) {
  const path = join(PROGRAMS_DIR, filename);
  try {
    const bytes = readFileSync(path);
    programBytes[key] = Array.from(bytes);
    console.log(`  ✅ ${key}: ${bytes.length} bytes`);
  } catch (error) {
    console.warn(`  ⚠️  ${key}: ${error.message} (will be empty)`);
    programBytes[key] = [];
  }
}

const tsContent = `/**
 * Auto-generated program bytes from .so files.
 * DO NOT EDIT - regenerated on build.
 *
 * Generated: ${new Date().toISOString()}
 */

export const PROGRAM_BYTES = {
  nativeToken: new Uint8Array([${programBytes.nativeToken}]),
  syntheticToken: new Uint8Array([${programBytes.syntheticToken}]),
  collateralToken: new Uint8Array([${programBytes.collateralToken}]),
} as const;

export type ProgramType = keyof typeof PROGRAM_BYTES;
`;

writeFileSync(OUTPUT_FILE, tsContent);
console.log(`\n✨ Generated ${OUTPUT_FILE}`);
console.log(`📁 Program bytes ready for import!\n`);
