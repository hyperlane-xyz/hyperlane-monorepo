import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const artifactsDir = path.join(__dirname, '../artifacts');
const outputFile = path.join(__dirname, '../src/artifacts.ts');

const folders = fs
  .readdirSync(artifactsDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => dirent.name);

let programs = [];
let output = `import { Program } from '@provablehq/sdk';\n\n`;

const readContentFromPath = (filePath, programName) => {
  const content = fs.readFileSync(filePath, 'utf8');

  const escaped = content
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/`/g, '\\`')
    .replace(/\r?\n/g, '\\n');

  return 'export const ' + `${programName}` + ' = `' + `${escaped}` + '`;\n';
};

for (const folder of folders) {
  try {
    const filePath = path.join(artifactsDir, folder, 'build', 'main.aleo');
    const programName = folder.replace(/-/g, '_'); // sanitize folder name for variable names

    if (!programs.includes(programName)) {
      console.log('reading main.aleo file at ', filePath);
      output += readContentFromPath(filePath, programName);
      programs.push(programName);
    }

    const importsDir = path.join(artifactsDir, folder, 'build', 'imports');
    const importFiles = fs
      .readdirSync(importsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isFile())
      .map((dirent) => dirent.name);

    for (const importFile of importFiles) {
      const importFilePath = path.join(importsDir, importFile);
      const importFileName = importFile.replace('.aleo', '');

      if (!programs.includes(importFileName)) {
        console.log(
          `reading import file ${importFileName} for ${folder} at ${importFilePath}`,
        );
        output += readContentFromPath(importFilePath, importFileName);
        programs.push(importFileName);
      }
    }
  } catch (err) {
    console.warn(`Skipping folder ${folder}, error: ${err.message}`);
  }
}

output += `
export const programRegistry: Record<string, string> = {
  dispatch_proxy,
  credits,
  hook_manager,
  ism_manager,
  mailbox,
  validator_announce,
};

export function loadProgramsInDeployOrder(programName: string): Program[] {
  const visited = new Set<string>();
  const programs: Program[] = [];

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
  return programs;
}
`;

fs.writeFileSync(outputFile, output, 'utf8');
console.log('artifacts.ts generated successfully!');
