import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const cwd = process.cwd();

const allFiles = glob(cwd, [
  `!./artifacts-zk/contracts/interfaces/**/*.json`,
  `!./artifacts-zk/contracts/**/*.dbg.json`,
  `!./artifacts-zk/@openzeppelin/**/*.dbg.json`,

  `./artifacts-zk/contracts/**/+([a-zA-Z0-9_]).json`,
  `./artifacts-zk/@openzeppelin/**/+([a-zA-Z0-9_]).json`,
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Directory containing your JSON files
const outputFile = join(__dirname, 'types/artifacts/index.ts');
const outputDir = join(__dirname, 'types/artifacts');

const allFileNames = new Set();

// Start building the TypeScript export string
let exportStatements = allFiles
  .map((file) => {
    const fileName = basename(file, '.json');

    const fileContent = readFileSync(file, 'utf-8');
    const jsonObject = JSON.parse(fileContent);

    allFileNames.add(`${fileName}__artifact`); // Add the filename to the array

    // Create a TypeScript object export statement
    return `export const ${fileName}__artifact = ${JSON.stringify(
      jsonObject,
      null,
      2,
    )} as const;`;
  })
  .join('\n\n');

exportStatements += `\n\nexport const allArtifacts = [\n${Array.from(
  allFileNames,
).join(',\n')}\n] as const;`;

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Write the index.ts file
writeFileSync(outputFile, exportStatements);

console.log(
  `Generated TypeScript object exports for ${allFiles.length} JSON files in configs/`,
);
