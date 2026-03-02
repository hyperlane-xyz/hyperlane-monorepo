import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import unzipper from 'unzipper';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputFile = path.join(__dirname, '../src/artifacts.ts');

const VERSION = 'v1.0.0';

async function fetchWithRetry(url, options, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);
      return res;
    } catch (e) {
      if (i === attempts - 1) throw e;
      const delay = 1000 * 2 ** i;
      console.log(`Fetch attempt ${i + 1} failed, retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

const main = async () => {
  const res = await fetchWithRetry(
    `https://github.com/hyperlane-xyz/hyperlane-aleo/releases/download/${VERSION}/programs.zip`,
    { cache: 'no-store' },
  );

  const buffer = Buffer.from(await res.arrayBuffer());

  const directory = await unzipper.Open.buffer(buffer);

  const files = [];

  for (const entry of directory.files) {
    if (entry.type === 'File') {
      const filename = entry.path.replace('.aleo', '');
      const content = (await entry.buffer())
        .toString('utf8')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/`/g, '\\`')
        .replace(/\r?\n/g, '\\n');

      files.push({ filename, content });
    }
  }

  let output = '';

  for (const file of files) {
    output +=
      'export const ' +
      `${file.filename}` +
      ' = `' +
      `${file.content}` +
      '`;\n';
  }

  output += `\nexport type AleoProgram =`;

  for (const file of files) {
    output += `\n  | '${file.filename}'`;
  }

  output += `;`;

  output += `\n\nexport const programRegistry: Record<AleoProgram, string> = {`;

  for (const file of files) {
    output += `\n  ${file.filename},`;
  }

  output += `\n};\n`;

  fs.writeFileSync(outputFile, output, 'utf8');
  console.log('artifacts.ts generated successfully!');
};

main();
