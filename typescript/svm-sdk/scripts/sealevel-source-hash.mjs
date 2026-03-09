#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEALEVEL_ROOT = join(__dirname, '../../../rust/sealevel');

/** Directories to scan for .rs and Cargo.toml files. */
const SCAN_DIRS = ['programs', 'libraries'];

/** Standalone files that affect compilation output. */
const STANDALONE_FILES = [
  'Cargo.lock',
  'Cargo.toml',
  'rust-toolchain',
  '.cargo/config.toml',
  'programs/build-programs.sh',
];

/**
 * Computes a deterministic SHA-256 hash of all Rust sealevel source files
 * that affect the compiled .so program binaries.
 *
 * Includes: all .rs files, all Cargo.toml files in programs/ and libraries/,
 * plus workspace-level config files (Cargo.lock, rust-toolchain, etc.).
 *
 * @returns {string} Hex-encoded SHA-256 digest.
 */
export function computeSealevelSourceHash() {
  const files = [];

  for (const dir of SCAN_DIRS) {
    const fullDir = join(SEALEVEL_ROOT, dir);
    const entries = readdirSync(fullDir, { recursive: true });
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : entry.toString();
      if (name.endsWith('.rs') || name.endsWith('Cargo.toml')) {
        files.push(join(dir, name));
      }
    }
  }

  for (const f of STANDALONE_FILES) {
    files.push(f);
  }

  files.sort();

  const hash = createHash('sha256');
  for (const relPath of files) {
    const contents = readFileSync(join(SEALEVEL_ROOT, relPath));
    hash.update(relPath);
    hash.update('\0');
    hash.update(contents);
  }

  return hash.digest('hex');
}
