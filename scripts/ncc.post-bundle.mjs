import path from 'path';

import { readFile, writeFile } from 'fs/promises';

/**
 * Resolve the output directory path.
 * Uses CLI arg if provided, otherwise defaults to 'bundle' in cwd.
 */
function resolveOutputDir() {
  const cwd = process.cwd();

  // Check CLI argument for custom output dir
  if (process.argv[2]) {
    const arg = process.argv[2];
    return path.isAbsolute(arg) ? arg : path.join(cwd, arg);
  }

  // Default to 'bundle' in current working directory
  return path.join(cwd, 'bundle');
}

const OUTPUT_DIR = resolveOutputDir();
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'index.js');

const SHEBANG = '#!/usr/bin/env node';

const DIRNAME_SHIM = `
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
`.trim();

/**
 * Apply Node.js compatibility patches to the bundled output.
 * Handles both 'bundle' and 'cli-bundle' output directories.
 */
async function patchBundledExecutable() {
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
      `✔ Bundled executable patched for Node.js + file:// compatibility (${OUTPUT_DIR})`,
    );
  } catch (error) {
    console.error('✖ Failed to patch bundled executable:', error);
    process.exit(1);
  }
}

await patchBundledExecutable();
