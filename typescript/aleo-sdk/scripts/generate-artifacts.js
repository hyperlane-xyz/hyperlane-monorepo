import fs from 'fs';
import fetch from 'node-fetch';
import path from 'path';
import unzipper from 'unzipper';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const outputFile = path.join(__dirname, '../src/artifacts.ts');

const VERSION = 'v1.0.0-beta0';

const main = async () => {
  const res = await fetch(
    `https://github.com/hyperlane-xyz/hyperlane-aleo/releases/download/${VERSION}/programs.zip`,
    {
      cache: 'no-store',
    },
  );
  if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

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

  let output = `import { Program } from '@provablehq/sdk/mainnet.js';\n\n`;
  output += `const originalProgramIds = JSON.parse(process.env['ALEO_USE_ORIGINAL_PROGRAM_IDS'] || 'false');\n\n`;

  for (const file of files) {
    output +=
      'export const ' +
      `${file.filename}` +
      ' = `' +
      `${file.content}` +
      '`;\n';
  }

  output += `\nexport const programRegistry: Record<string, string> = {`;

  for (const file of files) {
    output += `\n  ${file.filename},`;
  }

  output += `\n};\n`;

  output += `
export function loadProgramsInDeployOrder(
  programName: string,
  coreSalt: string,
  warpSalt?: string,
): { id: string; program: string }[] {
  const visited = new Set<string>();
  let programs: Program[] = [];

  function visit(p: string) {
    if (visited.has(p)) return;
    visited.add(p);

    const code = programRegistry[p];
    if (!code) throw new Error(\`Program \${p} not found\`);

    const program = Program.fromString(code);

    program
      .getImports()
      .map((dep) => dep.replace('.aleo', ''))
      .forEach((dep) => visit(dep));

    programs.push(program);
  }

  visit(programName);

  if (!originalProgramIds) {
    programs = programs.map((p) =>
      Program.fromString(
        p
          .toString()
          .replaceAll(
            /(mailbox|hook_manager|dispatch_proxy|validator_announce).aleo/g,
            (_, p1) => \`\${p1}_\${coreSalt}.aleo\`,
          )
          .replaceAll(
            /(hyp_native|hyp_collateral|hyp_synthetic).aleo/g,
            (_, p1) => \`\${p1}_\${warpSalt || coreSalt}.aleo\`,
          ),
      ),
    );
  }

  return programs.map((p) => ({
    id: p.id(),
    program: p.toString(),
  }));
}
`;

  fs.writeFileSync(outputFile, output, 'utf8');
  console.log('artifacts.ts generated successfully!');
};

main();
