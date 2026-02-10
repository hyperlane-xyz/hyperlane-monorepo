import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG = {
  cwd: process.cwd(),
  artifactGlobs: [
    `!./artifacts-tron/!(build-info)/**/*.dbg.json`,
    `./artifacts-tron/!(build-info)/**/+([a-zA-Z0-9_]).json`,
  ],
  formatIdentifier: 'hh-sol-artifact-1',
  outputDir: join(__dirname, '..', 'typescript', 'tron-sdk', 'src', 'abi'),
};

class TronArtifactGenerator {
  constructor() {
    this.processedFiles = new Set();
  }

  getArtifactPaths() {
    return glob(CONFIG.cwd, CONFIG.artifactGlobs);
  }

  async ensureOutputDir() {
    await fs.mkdir(CONFIG.outputDir, { recursive: true });
  }

  async processArtifact(filePath) {
    const name = basename(filePath, '.json');

    if (this.processedFiles.has(name)) {
      return;
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const artifact = JSON.parse(content);

    if (
      !artifact._format ||
      !artifact._format.includes(CONFIG.formatIdentifier)
    ) {
      return;
    }

    const output = {
      contractName: artifact.contractName,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
      deployedBytecode: artifact.deployedBytecode,
    };

    await fs.writeFile(
      join(CONFIG.outputDir, `${name}.json`),
      JSON.stringify(output, null, 2) + '\n',
    );

    this.processedFiles.add(name);
  }

  async generate() {
    await this.ensureOutputDir();

    const artifactPaths = this.getArtifactPaths();

    for (const filePath of artifactPaths) {
      await this.processArtifact(filePath);
    }

    console.log(
      `Successfully generated ${this.processedFiles.size} tron artifacts to ${CONFIG.outputDir}`,
    );
  }
}

const generator = new TronArtifactGenerator();
generator.generate().catch((err) => {
  console.error('Error generating tron artifacts:', err);
  process.exit(1);
});
