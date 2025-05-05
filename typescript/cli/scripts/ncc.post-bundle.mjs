import path from 'path';
import { fileURLToPath } from 'url';

import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputFile = path.join(__dirname, '..', 'cli-bundle', 'index.js');

const shebang = '#! /usr/bin/env node';
const dirnameDef = `import { fileURLToPath } from 'url';
import path from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);`;

async function prepend() {
  try {
    const content = await readFile(outputFile, 'utf8');

    // Assume the 'cli.ts' file entry point already has the shebang
    if (!content.startsWith(shebang)) {
      throw new Error('Missing shebang from cli entry point');
    }

    if (!content.includes(dirnameDef)) {
      const [, executable] = content.split(shebang);
      const newContent = `${shebang}\n${dirnameDef}\n${executable}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Adding missing __dirname definition to cli executable');
    }
  } catch (err) {
    console.error('Error processing output file:', err);
  }
}

await prepend();
