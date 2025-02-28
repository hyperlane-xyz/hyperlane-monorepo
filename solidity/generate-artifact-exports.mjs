import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const cwd = process.cwd();

const zksyncArtifacts = glob(cwd, [
  `!./artifacts-zk/!(build-info)/**/*.dbg.json`,
  `./artifacts-zk/!(build-info)/**/+([a-zA-Z0-9_]).json`,
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Directory to store individual artifact files
const srcOutputDir = join(__dirname, 'core-utils/zksync/artifacts/output');

// Ensure the output directory exists
if (!existsSync(srcOutputDir)) {
  mkdirSync(srcOutputDir, { recursive: true });
}

const zkSyncFileNames = new Set();
let zkSyncArtifactMap = {};

// Process each artifact file
zksyncArtifacts.forEach((file) => {
  const fileContent = readFileSync(file, 'utf-8');
  const jsonObject = JSON.parse(fileContent);
  const contractName = jsonObject.contractName;
  let fileName = `${basename(file, '.json')}`;

  if (zkSyncFileNames.has(fileName)) {
    return;
  }
  zkSyncFileNames.add(fileName);

  // Add to artifact map
  zkSyncArtifactMap[contractName] = fileName;

  // Create a TypeScript object export statement
  const fileContentEx = `export const ${fileName} = ${JSON.stringify(
    jsonObject,
    null,
    2,
  )} as const;`;

  // Write individual file
  const outputFile = join(srcOutputDir, `${fileName}.ts`);
  writeFileSync(outputFile, fileContentEx);
});

console.log(
  `Generated ${zksyncArtifacts.length} individual TypeScript files in ${srcOutputDir}`,
);
