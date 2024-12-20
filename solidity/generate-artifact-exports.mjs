import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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

if (!existsSync(srcOutputDir)) {
  mkdirSync(srcOutputDir, { recursive: true });
}

/**
 * @dev Reads each artifact file and writes it to srcOutputDir
 */
zksyncArtifacts.forEach((file) => {
  const fileContent = readFileSync(file, 'utf-8');
  let fileName = `${basename(file, '.json')}`;

  const outputFile = join(srcOutputDir, `${fileName}.json`);

  writeFileSync(outputFile, fileContent);
});

console.log(
  `Generated ${zksyncArtifacts.length} individual JSON Artifacts in ${srcOutputDir}`,
);
