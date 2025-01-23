import { promises as fsPromises } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const cwd = process.cwd();

/**
 * @dev Only includes primary JSON artifacts & excludes debug files and build-info directory
 */
const zksyncArtifacts = glob(cwd, [
  `!./artifacts-zk/!(build-info)/**/*.dbg.json`,
  `./artifacts-zk/!(build-info)/**/+([a-zA-Z0-9_]).json`,
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const srcOutputDir = join(__dirname, 'core-utils/zksync/artifacts');

// Ensure output directory exists
await fsPromises.mkdir(srcOutputDir, { recursive: true });

/**
 * @dev Processes a single artifact file
 */
async function processArtifactFile(file) {
  const fileName = `${basename(file, '.json')}`;
  const outputFile = join(srcOutputDir, `${fileName}.json`);

  // Check if file already exists
  const fileExists = await fsPromises
    .access(outputFile)
    .then(() => true)
    .catch(() => false);

  if (fileExists) {
    // File already exists, skipping...
    // NOTE: Hardhat compiler produces duplicate artifacts when
    // shared interfaces/libraries are used across different contracts
    // This is expected behavior and we only need one copy of each artifact
    return;
  }

  const fileContent = await fsPromises.readFile(file, { encoding: 'utf-8' });
  await fsPromises.writeFile(outputFile, fileContent);
}

/**
 * @dev Reads each artifact file and writes it to srcOutputDir concurrently
 */
await Promise.all(
  zksyncArtifacts.map(async (file) => {
    try {
      await processArtifactFile(file);
    } catch (error) {
      console.error(`Error processing file ${file}:`, error);
    }
  }),
);
