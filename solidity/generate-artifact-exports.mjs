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
 * @dev Reads each artifact file and writes it to srcOutputDir concurrently
 */
await Promise.all(
  zksyncArtifacts.map(async (file) => {
    try {
      const fileContent = await fsPromises.readFile(file, {
        encoding: 'utf-8',
      });
      const fileName = `${basename(file, '.json')}`;
      const outputFile = join(srcOutputDir, `${fileName}.json`);

      await fsPromises.writeFile(outputFile, fileContent);
    } catch (error) {
      console.error(`Error processing file ${file}:`, error);
    }
  }),
);
