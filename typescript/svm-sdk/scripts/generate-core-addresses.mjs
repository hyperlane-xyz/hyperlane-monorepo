#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENVIRONMENTS_DIR = join(
  __dirname,
  '../../../rust/sealevel/environments/mainnet3',
);
const OUTPUT_FILE = join(__dirname, '../src/generated/core-addresses.ts');

/** Snake_case key to camelCase. */
function camelCase(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

const chains = {};

for (const entry of readdirSync(ENVIRONMENTS_DIR, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;

  const programIdsPath = join(
    ENVIRONMENTS_DIR,
    entry.name,
    'core',
    'program-ids.json',
  );

  let raw;
  try {
    raw = JSON.parse(readFileSync(programIdsPath, 'utf-8'));
  } catch {
    continue; // no core/program-ids.json for this entry
  }

  const camelCased = {};
  for (const [key, value] of Object.entries(raw)) {
    camelCased[camelCase(key)] = value;
  }

  chains[entry.name] = camelCased;
}

const chainNames = Object.keys(chains).sort();

if (chainNames.length === 0) {
  console.error('No valid chains found in', ENVIRONMENTS_DIR);
  process.exit(1);
}

const interfaceFields = Object.keys(chains[chainNames[0]])
  .map((k) => `  ${k}: string;`)
  .join('\n');

const entries = chainNames
  .map((chain) => {
    const fields = Object.entries(chains[chain])
      .map(([k, v]) => `    ${k}: '${v}',`)
      .join('\n');
    return `  ${chain}: {\n${fields}\n  },`;
  })
  .join('\n');

const tsContent = `/**
 * Auto-generated SVM core deployment addresses from rust/sealevel/environments/mainnet3.
 * DO NOT EDIT — regenerate with: node scripts/generate-core-addresses.mjs
 */

export interface SvmCoreAddresses {
${interfaceFields}
}

export const SVM_CORE_ADDRESSES: Record<string, SvmCoreAddresses> = {
${entries}
};
`;

mkdirSync(dirname(OUTPUT_FILE), { recursive: true });
writeFileSync(OUTPUT_FILE, tsContent);
console.log(
  `Generated ${OUTPUT_FILE} with ${chainNames.length} chains: ${chainNames.join(', ')}`,
);
