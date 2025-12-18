import path from 'path';
import { fileURLToPath } from 'url';

import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputFile = path.join(__dirname, '..', 'cli-bundle', 'index.js');

const shebang = '#! /usr/bin/env node';
const dirnameDef = `import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);`;

async function prepend() {
  try {
    const content = await readFile(outputFile, 'utf8');

    if (!content.includes(dirnameDef)) {
      // Remove existing shebang if present
      const executable = content.startsWith(shebang)
        ? content.slice(shebang.length)
        : content;
      // Patch WASM loading to use file:// URL for Node.js compatibility
      let patchedExecutable = executable.replace(
        /await __wbg_init\(\{ module_or_path: (module\$\d+) \}\)/g,
        'await __wbg_init({ module_or_path: pathToFileURL($1).href })',
      );
      // Patch spawnWorker to convert filepath to file:// URL for Worker compatibility
      patchedExecutable = patchedExecutable.replace(
        'const worker = new Worker(url,',
        'const worker = new Worker(pathToFileURL(url),',
      );
      const newContent = `${shebang}\n${dirnameDef}\n${patchedExecutable}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Patched cli executable with __dirname and file:// URL fix');
    }
  } catch (err) {
    console.error('Error processing output file:', err);
  }
}

await prepend();
