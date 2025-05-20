import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { StarknetArtifactGenerator } from './StarknetArtifactGenerator.js';

const cwd = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_ROOT_OUTPUT_DIR = join(__dirname, '../dist/artifacts/');
const DEFAULT_COMPILED_CONTRACTS_DIR = join(cwd, 'release');

(async () => {
  try {
    const generator = new StarknetArtifactGenerator(
      DEFAULT_COMPILED_CONTRACTS_DIR,
      DEFAULT_ROOT_OUTPUT_DIR,
    );
    const processedFiles = await generator.generate();
    console.log(`Successfully generated ${processedFiles.size} artifacts`);
  } catch (error) {
    console.error('Artifact generation failed:', error);
    process.exit(1);
  }
})();
