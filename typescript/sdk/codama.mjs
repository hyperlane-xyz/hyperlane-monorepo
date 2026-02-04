#!/usr/bin/env node

import { rootNodeFromAnchor } from '@codama/nodes-from-anchor';
import { renderVisitor } from '@codama/renderers-js';
import { createFromRoot } from 'codama';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// IDL file paths relative to this script
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

console.log('🔧 Generating TypeScript clients from Hyperlane Sealevel IDLs...\n');

for (const idlFile of IDL_FILES) {
  const idlPath = join(IDL_BASE, idlFile);
  const programName = idlFile.replace('.json', '');

  console.log(`📦 Processing ${programName}...`);

  try {
    // Read and parse the IDL
    const idlContent = readFileSync(idlPath, 'utf-8');
    const anchorIdl = JSON.parse(idlContent);

    // Verify metadata.origin is set to 'shank'
    if (!anchorIdl.metadata || anchorIdl.metadata.origin !== 'shank') {
      console.warn(`  ⚠️  Warning: ${programName} does not have metadata.origin set to 'shank'`);
    }

    // Convert Anchor/Shank IDL to Codama IDL
    const rootNode = rootNodeFromAnchor(anchorIdl);
    const codama = createFromRoot(rootNode);

    // Generate TypeScript client
    codama.accept(
      renderVisitor(join(OUTPUT_DIR, programName), {
        formatCode: true,
        prettierOptions: {
          semi: true,
          singleQuote: true,
          trailingComma: 'all',
          arrowParens: 'always',
        },
      })
    );

    console.log(`  ✅ Generated client in ${OUTPUT_DIR}/${programName}`);
  } catch (error) {
    console.error(`  ❌ Error processing ${programName}:`, error.message);
    process.exit(1);
  }
}

console.log('\n✨ All TypeScript clients generated successfully!');
console.log(`📁 Output directory: ${OUTPUT_DIR}`);
