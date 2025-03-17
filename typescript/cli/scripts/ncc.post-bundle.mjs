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
    if (!content.startsWith(shebang) && content.includes(dirnameDef)) {
      const newContent = shebang + content;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Adding missing shebang to cli executable.');
    }
    if (content.startsWith(shebang) && !content.includes(dirnameDef)) {
      const [, executable] = content.split(shebang);
      const newContent = `${shebang}\n${dirnameDef}\n${executable}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log('Adding missing __dirname definition to cli executable');
    } else {
      const newContent = `${shebang}\n${dirnameDef}\n${content}`;
      await writeFile(outputFile, newContent, 'utf8');
      console.log(
        'Adding missing shebang and __dirname definition to output file.',
      );
    }
  } catch (err) {
    console.error('Error processing output file:', err);
  }
}

await prepend();
