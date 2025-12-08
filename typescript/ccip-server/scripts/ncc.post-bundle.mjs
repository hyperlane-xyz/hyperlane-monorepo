import path from 'path';
import { fileURLToPath } from 'url';

import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputFile = path.join(__dirname, '..', 'ccip-server-bundle', 'index.js');

const dirnameDef = `import { fileURLToPath } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);`;

async function prepend() {
  try {
    const content = await readFile(outputFile, 'utf8');

    // Add __dirname definition if missing (ncc bundles often break __dirname)
    if (!content.includes('__dirname')) {
      const newContent = `${dirnameDef}\n${content}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Adding missing __dirname definition to bundle');
    }
  } catch (err) {
    console.error('Error processing output file:', err);
  }
}

await prepend();
