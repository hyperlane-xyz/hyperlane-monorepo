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
let output = '';

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
// Map from program name to program source code export variable
const programs: Record<string, string> = {
  dispatch_proxy,
  credits,
  hook_manager,
  ism_manager,
  mailbox,
  validator_announce,
};

function parseImports(programCode: string): string[] {
  // Regex to capture 'import SOMETHING.aleo;' -> extract 'SOMETHING'
  const regex = /^import\\s+(\\w+)\.aleo;/gm;
  const imports: string[] = [];
  let match;
  while ((match = regex.exec(programCode)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

export function loadPrograms(programName: string): { programName: string, program: string }[] {
  const visited = new Set<string>();
  const result: { programName: string, program: string }[] = [];

  function visit(prog: string) {
    if (visited.has(prog)) return;
    visited.add(prog);

    const code = programs[prog]; 
    if (!code) throw new Error('Program not found');

    const deps = parseImports(code);
    for (const dep of deps) {
      visit(dep);
    }
    result.push({
      programName: prog,
      program: code
    });
  }

  visit(programName);
  return result;
}
`;

fs.writeFileSync(outputFile, output, 'utf8');
console.log('artifacts.ts generated successfully!');
