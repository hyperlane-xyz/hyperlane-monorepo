import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { StarknetArtifactGenerator } from './StarknetArtifactGenerator.js';

const cwd = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_ROOT_OUTPUT_DIR = join(__dirname, '../dist/artifacts/');
const DEFAULT_COMPILED_CONTRACTS_DIR = join(cwd, 'release');

new StarknetArtifactGenerator(
  DEFAULT_COMPILED_CONTRACTS_DIR,
  DEFAULT_ROOT_OUTPUT_DIR,
)
  .generate()
  .catch(console.error);
