import path from 'path';
import { fileURLToPath } from 'url';

import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OUTPUT_FILE = path.join(__dirname, '..', 'cli-bundle', 'index.js');
// Use -S to pass additional arguments to node
// --no-warnings suppresses process warnings like the node-fetch DeprecationWarning
// about .data not being a valid RequestInit property (comes from gaxios via Google Cloud libs)
const SHEBANG = '#!/usr/bin/env -S node --no-warnings';

// This shim runs before any other code and:
// 1. Adds __dirname/__filename support for ESM
// 2. Suppresses the bigint-buffer console.warn about native bindings
//    (comes from @solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer)
const DIRNAME_SHIM = `
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Suppress bigint-buffer warning about native bindings
// The warning is harmless - it just uses a slower pure JS implementation
const _origWarn = console.warn;
console.warn = (...args) => {
  if (args[0]?.includes?.('bigint: Failed to load bindings')) return;
  _origWarn.apply(console, args);
};
`.trim();

/**
 * Apply Node.js compatibility patches to the bundled CLI output.
 */
async function patchCliExecutable() {
  try {
    let content = await readFile(OUTPUT_FILE, 'utf8');

    // Skip if already patched
    if (content.includes(DIRNAME_SHIM)) {
      return;
    }

    // Remove any existing shebang *and* leading whitespace
    content = content.replace(/^#!.*\n/, '');

    // Patch WASM init to use file:// URLs
    content = content.replace(
      /await __wbg_init\(\{ module_or_path: (module\$\d+) \}\)/g,
      'await __wbg_init({ module_or_path: pathToFileURL($1).href })',
    );

    // Patch Worker creation to accept file:// URLs
    content = content.replace(
      'const worker = new Worker(url,',
      'const worker = new Worker(pathToFileURL(url),',
    );

    const patched = [SHEBANG, DIRNAME_SHIM, '', content].join('\n');

    await writeFile(OUTPUT_FILE, patched, 'utf8');

    console.log(
      '✔ CLI executable patched for Node.js + file:// compatibility',
    );
  } catch (error) {
    console.error('✖ Failed to patch CLI executable:', error);
    if (!content.includes(dirnameDef)) {
      const [, executable] = content.split(shebang);
      const newContent = `${shebang}\n${dirnameDef}\n${executable}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Adding missing __dirname definition to cli executable');
    }
  }
}

await patchCliExecutable();
