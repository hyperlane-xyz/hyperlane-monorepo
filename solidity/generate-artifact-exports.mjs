import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const CONFIG = {
  cwd: process.cwd(),
  outputDir: 'dist/zksync/',
  artifactsDir: 'artifacts',
  artifactGlobs: [
    `!./artifacts-zk/!(build-info)/**/*.dbg.json`,
    `./artifacts-zk/!(build-info)/**/+([a-zA-Z0-9_]).json`,
  ],
  formatIdentifier: 'hh-zksolc-artifact-1',
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_OUTPUT_DIR = join(__dirname, CONFIG.outputDir);
const ARTIFACTS_OUTPUT_DIR = join(ROOT_OUTPUT_DIR, CONFIG.artifactsDir);

/**
 * @notice Templates for TypeScript artifact generation
 */
class Templates {
  static jsArtifact(name, artifact) {
    return `export const ${name} = ${JSON.stringify(artifact)};`;
  }

  static dtsArtifact(name) {
    return `import type { ZKSyncArtifact } from '../types.js';
export declare const ${name}: ZKSyncArtifact;`;
  }

  static jsIndex(imports, exports) {
    return `${imports}
export const zkSyncContractArtifacts = [
${exports}
];`;
  }

  static dtsIndex() {
    return `import type { ZKSyncArtifact } from './types.js';
export declare const zkSyncContractArtifacts: readonly ZKSyncArtifact[];`;
  }

  // Generates a single import line for a contract in index file
  static importLine(name) {
    return `import { ${name} } from './artifacts/${name}.js';`;
  }

  // Generates a single export line for a contract in index file
  static exportLine(name) {
    return `  ${name},`;
  }
}

class ArtifactGenerator {
  constructor() {
    this.processedFiles = new Set();
  }

  /**
   * @notice Retrieves paths of all relevant artifact files
   * @dev Excludes debug files and build-info directory
   * @return {string[]} Array of file paths matching the glob pattern
   */
  getArtifactPaths() {
    return glob(CONFIG.cwd, CONFIG.artifactGlobs);
  }

  /**
   * @notice Creates the output directory if it doesn't exist
   */
  async createOutputDirectory() {
    await fs.mkdir(ARTIFACTS_OUTPUT_DIR, { recursive: true });
  }

  /**
   * @notice Reads and parses a JSON artifact file
   * @param filePath Path to the artifact file
   * @return {Promise<Object>} Parsed JSON content
   */
  async readArtifactFile(filePath) {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * @notice Processes a single artifact file
   */
  async processArtifact(filePath) {
    const name = basename(filePath, '.json');

    if (this.processedFiles.has(name)) {
      return;
    }

    const artifact = await this.readArtifactFile(filePath);

    /**
     * @notice Validates that the artifact was compiled with zksolc
     *
     * Format examples:
     * - Valid:   "_format": "hh-zksolc-artifact-1" (compiled with zksolc)
     * - Invalid: "_format": "hh-sol-artifact-1" (standard Solidity compilation)
     */
    if (
      !artifact._format ||
      !artifact._format.includes(CONFIG.formatIdentifier)
    ) {
      throw new Error(
        `Artifact ${name} validation failed: invalid _format property. Expected ${
          CONFIG.formatIdentifier
        } but got '${
          artifact._format || 'undefined'
        }'. It may not be properly compiled with zksolc.`,
      );
    }

    // Generate and write .js file
    const jsContent = Templates.jsArtifact(name, artifact);
    await fs.writeFile(
      join(ROOT_OUTPUT_DIR, 'artifacts', `${name}.js`),
      jsContent,
    );

    // Generate and write .d.ts file
    const dtsContent = Templates.dtsArtifact(name);
    await fs.writeFile(
      join(ROOT_OUTPUT_DIR, 'artifacts', `${name}.d.ts`),
      dtsContent,
    );

    this.processedFiles.add(name);
  }

  /**
   * @notice Generates index file contents
   */
  generateIndexContents(artifactNames) {
    const imports = artifactNames
      .map((name) => Templates.importLine(name))
      .join('\n');
    const exports = artifactNames
      .map((name) => Templates.exportLine(name))
      .join('\n');

    const jsContent = Templates.jsIndex(imports, exports);
    const dtsContent = Templates.dtsIndex();

    return { jsContent, dtsContent };
  }

  async generate() {
    try {
      await this.createOutputDirectory();

      const artifactPaths = this.getArtifactPaths();

      for (const filePath of artifactPaths) {
        await this.processArtifact(filePath);
      }

      const processedNames = Array.from(this.processedFiles);

      // Generate and write index files
      const { jsContent, dtsContent } =
        this.generateIndexContents(processedNames);

      await fs.writeFile(join(ROOT_OUTPUT_DIR, 'artifacts.js'), jsContent);
      await fs.writeFile(join(ROOT_OUTPUT_DIR, 'artifacts.d.ts'), dtsContent);

      console.log(
        `Successfully processed ${processedNames.length} zksync artifacts`,
      );
    } catch (error) {
      console.error('Error processing zksync artifacts:', error);
      throw error;
    }
  }
}

const generator = new ArtifactGenerator();
generator.generate().catch(console.error);
