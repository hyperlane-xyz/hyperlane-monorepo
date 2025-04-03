import { promises as fs } from 'fs';
import { basename, dirname, join } from 'path';
import { glob } from 'typechain';
import { fileURLToPath } from 'url';

const cwd = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_OUTPUT_DIR = join(__dirname, 'dist/zksync/');
const ARTIFACTS_OUTPUT_DIR = join(ROOT_OUTPUT_DIR, 'artifacts');

/**
 * @notice Templates for TypeScript artifact generation
 */
const TEMPLATES = {
  JS_ARTIFACT: `\
export const {name} = {artifact};
`,

  DTS_ARTIFACT: `\
import type { ZKSyncArtifact } from '../types.js';

export declare const {name}: ZKSyncArtifact;
`,

  JS_INDEX: `\
{imports}

export const zkSyncContractArtifacts = [
{exports}
];
`,

  DTS_INDEX: `\
import type { ZKSyncArtifact } from './types.js';

export declare const zkSyncContractArtifacts: readonly ZKSyncArtifact[];
`,
};

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
    return glob(cwd, [
      `!./artifacts-zk/!(build-info)/**/*.dbg.json`,
      `./artifacts-zk/!(build-info)/**/+([a-zA-Z0-9_]).json`,
    ]);
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
   * @notice Generates JavaScript content for a contract artifact
   */
  generateJavaScriptContent(name, artifact) {
    return TEMPLATES.JS_ARTIFACT.replace('{name}', name).replace(
      '{artifact}',
      JSON.stringify(artifact, null, 2),
    );
  }

  /**
   * @notice Generates TypeScript declaration content for a contract artifact
   */
  generateDeclarationContent(name) {
    return TEMPLATES.DTS_ARTIFACT.replace('{name}', name);
  }

  /**
   * @notice Generates index file contents
   */
  generateIndexContents(artifactNames) {
    const imports = artifactNames
      .map((name) => `import { ${name} } from './artifacts/${name}.js';`)
      .join('\n');
    const exports = artifactNames.map((name) => `  ${name},`).join('\n');

    const jsContent = TEMPLATES.JS_INDEX.replace('{imports}', imports).replace(
      '{exports}',
      exports,
    );

    const dtsContent = TEMPLATES.DTS_INDEX.replace(
      '{imports}',
      imports,
    ).replace('{exports}', exports);

    return { jsContent, dtsContent };
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

    // Generate and write .js file
    const jsContent = this.generateJavaScriptContent(name, artifact);
    await fs.writeFile(
      join(ROOT_OUTPUT_DIR, 'artifacts', `${name}.js`),
      jsContent,
    );

    // Generate and write .d.ts file
    const dtsContent = this.generateDeclarationContent(name);
    await fs.writeFile(
      join(ROOT_OUTPUT_DIR, 'artifacts', `${name}.d.ts`),
      dtsContent,
    );

    this.processedFiles.add(name);
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
