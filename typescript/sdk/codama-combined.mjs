#!/usr/bin/env node
/* eslint-disable no-console */
/* eslint-disable import/no-nodejs-modules */
import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot, rootNode } from 'codama';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IDL_BASE = join(__dirname, '../../rust/sealevel/programs/idl');
const OUTPUT_DIR = join(__dirname, 'src/providers/sealevel/generated');

const IDL_FILES = [
  // Tier 1: Core Infrastructure
  'hyperlane_sealevel_mailbox.json',
  'hyperlane_sealevel_igp.json',
  'hyperlane_sealevel_validator_announce.json',
  // Tier 2: Application Layer
  'hyperlane_sealevel_hello_world.json',
  'hyperlane_sealevel_token.json',
  'hyperlane_sealevel_token_native.json',
  'hyperlane_sealevel_token_collateral.json',
  // Tier 3: ISM Programs
  'hyperlane_sealevel_multisig_ism_message_id.json',
  'hyperlane_sealevel_test_ism.json',
];

console.log(
  '🔧 Generating TypeScript clients from Hyperlane Sealevel IDLs...\n',
);
console.log('📦 Loading and combining all IDLs into single Codama tree...\n');

const programNodes = [];

for (const idlFile of IDL_FILES) {
  const idlPath = join(IDL_BASE, idlFile);
  const programName = idlFile.replace('.json', '');

  try {
    const idlContent = readFileSync(idlPath, 'utf-8');
    const anchorIdl = JSON.parse(idlContent);

    if (!anchorIdl.metadata || anchorIdl.metadata.origin !== 'shank') {
      console.warn(
        `  ⚠️  Warning: ${programName} does not have metadata.origin set to 'shank'`,
      );
    }

    const programNode = rootNodeFromAnchor(anchorIdl);
    programNodes.push(programNode);
    console.log(`  ✅ Loaded ${programName}`);
  } catch (error) {
    console.error(`  ❌ Error loading ${programName}:`, error.message);
    process.exit(1);
  }
}

// Combine all programs into a single root node
const [firstProgram, ...additionalPrograms] = programNodes;
const mainProgram = firstProgram.program;
const otherPrograms = additionalPrograms.map((root) => root.program);

const combinedRoot = rootNode(mainProgram, otherPrograms);
const codama = createFromRoot(combinedRoot);

console.log(
  `\n🔨 Generating TypeScript clients with cross-program references...\n`,
);

codama.accept(
  renderVisitor(OUTPUT_DIR, {
    formatCode: true,
    emitNodeEsmSpecifiers: true,
    prettierOptions: {
      semi: true,
      singleQuote: true,
      trailingComma: 'all',
      arrowParens: 'always',
    },
  }),
);

console.log(`\n✨ All TypeScript clients generated successfully!`);
console.log(`📁 Output directory: ${OUTPUT_DIR}`);
