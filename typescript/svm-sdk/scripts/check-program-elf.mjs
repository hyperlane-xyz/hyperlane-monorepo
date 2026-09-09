#!/usr/bin/env node
/* eslint-disable no-console, import/no-nodejs-modules */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HYPERLANE_SVM_PROGRAM_BYTES } from '../src/hyperlane/program-bytes.ts';
import { PROGRAMS } from './programs.mjs';

const deploy = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../rust/sealevel/target/deploy',
);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const [key, filename] of Object.entries(PROGRAMS)) {
  const compiled = hash(readFileSync(join(deploy, filename)));
  const embedded = hash(HYPERLANE_SVM_PROGRAM_BYTES[key]);
  if (compiled !== embedded) {
    throw new Error(
      `${filename}: rebuilt ELF ${compiled} differs from embedded ${embedded}; rebuild and run program:generate`,
    );
  }
  console.log(`${filename}: ${compiled}`);
}
