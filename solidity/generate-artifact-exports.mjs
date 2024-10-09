import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const cwd = process.cwd();

const zksyncArtifacts = glob(cwd, [
  `!./artifacts-zk/contracts/**/*.dbg.json`,
  `!./artifacts-zk/@openzeppelin/**/*.dbg.json`,
  `./artifacts-zk/contracts/**/+([a-zA-Z0-9_]).json`,
  `./artifacts-zk/@openzeppelin/**/+([a-zA-Z0-9_]).json`,
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Directory containing your JSON files
const outputFile = join(__dirname, 'types/zksync/artifacts/index.ts');
const outputDir = join(__dirname, 'types/zksync/artifacts');

const zkSyncFileNames = new Set();

let zkSyncArtifactMap = {};

// Start building the TypeScript export string
let exportStatements = zksyncArtifacts
  .map((file) => {
    const fileContent = readFileSync(file, 'utf-8');
    const jsonObject = JSON.parse(fileContent);
    const contractName = jsonObject.contractName;
    let fileName = `${basename(file, '.json')}__artifact`;

    if (zkSyncFileNames.has(fileName)) {
      return;
    }
    zkSyncFileNames.add(fileName);

    // Add to artifact map
    zkSyncArtifactMap[contractName] = fileName;

    // Create a TypeScript object export statement
    return `export const ${fileName} = ${JSON.stringify(
      jsonObject,
      null,
      2,
    )} as const;`;
  })
  .join('\n\n');

exportStatements += `\n\nexport const zksyncArtifacts : any[] = [\n${Array.from(
  zkSyncFileNames,
).join(',\n')}\n] as const;`;

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

// Write the index.ts file
writeFileSync(outputFile, exportStatements);

console.log(
  `Generated TypeScript object exports for ${zksyncArtifacts.length} JSON files in configs/`,
);
