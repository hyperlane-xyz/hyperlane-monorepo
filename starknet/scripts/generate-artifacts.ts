import { promises as fs } from 'fs';
import { globby } from 'globby';
import { basename, dirname, join } from 'path';
import { CompiledContract } from 'starknet';
import { fileURLToPath } from 'url';

import { CONTRACT_SUFFIXES } from '../src/const.js';
import { ContractClass, ContractType } from '../src/types.js';

import { Templates } from './utils/templates.js';

const cwd = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_ROOT_OUTPUT_DIR = join(__dirname, '../dist/artifacts/');
const DEFAULT_COMPILED_CONTRACTS_DIR = join(cwd, 'release');

type ProcessedFilesMap = Map<
  string,
  { type: ContractType; sierra: boolean; casm: boolean }
>;

export class StarknetArtifactGenerator {
  private processedFiles: ProcessedFilesMap;
  private contractExports: string[] = [];
  private tokenExports: string[] = [];
  private mockExports: string[] = [];
  private compiledContractsDir: string;
  private rootOutputDir: string;

  constructor(
    compiledContractsDir: string = DEFAULT_COMPILED_CONTRACTS_DIR,
    rootOutputDir: string = DEFAULT_ROOT_OUTPUT_DIR,
  ) {
    this.processedFiles = new Map();
    this.compiledContractsDir = compiledContractsDir;
    this.rootOutputDir = rootOutputDir;
  }

  getContractTypeFromPath(path: string): ContractType {
    const fileName = basename(path);
    if (fileName.startsWith('token_')) {
      return ContractType.TOKEN;
    } else if (fileName.startsWith('mocks_')) {
      return ContractType.MOCK;
    }
    return ContractType.CONTRACT;
  }

  getContractClassFromPath(filePath: string): ContractClass {
    if (filePath.includes('compiled_contract_class')) {
      return ContractClass.CASM;
    } else if (filePath.includes('contract_class')) {
      return ContractClass.SIERRA;
    } else {
      throw new Error(`Cannot determine contract class from path: ${filePath}`);
    }
  }

  /**
   * @notice Retrieves paths of all relevant artifact files
   */
  async getArtifactPaths() {
    const sierraPattern = `${this.compiledContractsDir}/**/*${CONTRACT_SUFFIXES.SIERRA_JSON}`;
    const [sierraFiles] = await Promise.all([globby(sierraPattern)]);
    return { sierraFiles };
  }

  /**
   * @notice Creates the output directory if it doesn't exist
   */
  async createOutputDirectory() {
    await fs.mkdir(this.rootOutputDir, { recursive: true });
  }

  /**
   * @notice Reads and parses a JSON artifact file
   */
  async readArtifactFile(filePath: string) {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * @notice Generates JavaScript content for a contract artifact
   */
  generateJavaScriptContent(
    name: string,
    artifact: any,
    contractClass: ContractClass,
  ) {
    // For Sierra contracts, extract the ABI if the file contains contract_class in its name
    if (contractClass === ContractClass.SIERRA) {
      const abiOnly: CompiledContract = {
        sierra_program: [],
        contract_class_version: artifact.contract_class_version,
        entry_points_by_type: artifact.entry_points_by_type,
        abi:
          typeof artifact.abi === 'string'
            ? JSON.parse(artifact.abi)
            : artifact.abi,
      };

      return Templates.jsArtifact(name, abiOnly);
    }
    // For other contract types, return the full artifact
    return Templates.jsArtifact(name, artifact);
  }

  /**
   * @notice Generates TypeScript declaration content for a contract artifact
   */
  generateDeclarationContent(name: string, isSierra: boolean) {
    const type = isSierra ? 'CompiledContract' : 'CairoAssembly';
    return Templates.dtsArtifact(name, type);
  }

  /**
   * @notice Generates index file contents with categorized contracts
   */
  generateIndexContents() {
    const imports: string[] = [];
    this.contractExports = [];
    this.tokenExports = [];
    this.mockExports = [];

    this.processedFiles.forEach((value, name) => {
      // Extracts the contract name by removing the prefix (contracts_, token_, or mocks_)
      // Example: "token_HypErc20" becomes "HypErc20"
      const baseName = name.replace(
        new RegExp(`^(${Object.values(ContractType).join('|')})_?`),
        '',
      );

      let sierraVarName;
      let casmVarName;

      if (value.sierra) {
        sierraVarName = `${value.type}_${baseName}_sierra`;
        imports.push(
          `import { ${name} as ${sierraVarName} } from './${name}.${ContractClass.SIERRA}.js';`,
        );
      }

      if (value.casm) {
        casmVarName = `${value.type}_${baseName}_casm`;
        imports.push(
          `import { ${name} as ${casmVarName} } from './${name}.${ContractClass.CASM}.js';`,
        );
      }

      const exports = [
        value.sierra ? `contract_class: ${sierraVarName}` : null,
        value.casm ? `compiled_contract_class: ${casmVarName}` : null,
      ].filter(Boolean);

      this.getExportArrayForType(value.type).push(
        `${baseName}: { ${exports.join(', ')} },`,
      );
    });

    return {
      jsContent: Templates.jsIndex(
        imports.join('\n'),
        this.contractExports.join('\n'),
        this.tokenExports.join('\n'),
        this.mockExports.join('\n'),
      ),
      dtsContent: Templates.dtsIndex(),
    };
  }

  private getExportArrayForType(type: ContractType): string[] {
    switch (type) {
      case ContractType.TOKEN:
        return this.tokenExports;
      case ContractType.MOCK:
        return this.mockExports;
      default:
        return this.contractExports;
    }
  }

  /**
   * @notice Processes a single artifact file
   */
  async processArtifact(filePath: string) {
    const contractType = this.getContractTypeFromPath(filePath);
    const contractClass = this.getContractClassFromPath(filePath);

    const baseFileName = basename(filePath);
    const name = baseFileName
      .replace('.json', '')
      .replace(`.${ContractClass.SIERRA}`, '')
      .replace(`.${ContractClass.CASM}`, '');

    const artifact = await this.readArtifactFile(filePath);
    const fileInfo = this.processedFiles.get(name) || {
      type: contractType,
      sierra: false,
      casm: false,
    };

    if (contractClass === ContractClass.SIERRA) {
      fileInfo.sierra = true;
    } else {
      fileInfo.casm = true;
    }

    this.processedFiles.set(name, fileInfo);

    // Generate and write files
    const jsContent = this.generateJavaScriptContent(
      name,
      artifact,
      contractClass,
    );
    const dtsContent = this.generateDeclarationContent(
      name,
      contractClass === ContractClass.SIERRA,
    );

    const outputFileName = `${name}.${contractClass}`;
    await fs.writeFile(
      join(this.rootOutputDir, outputFileName + '.js'),
      jsContent,
    );
    await fs.writeFile(
      join(this.rootOutputDir, outputFileName + '.d.ts'),
      dtsContent,
    );
  }

  async generate() {
    try {
      await this.createOutputDirectory();

      const { sierraFiles } = await this.getArtifactPaths();

      await Promise.all([
        ...sierraFiles.map((file) => this.processArtifact(file)),
      ]);

      // Generate and write index files
      const { jsContent, dtsContent } = this.generateIndexContents();
      await fs.writeFile(join(this.rootOutputDir, 'index.js'), jsContent);
      await fs.writeFile(join(this.rootOutputDir, 'index.d.ts'), dtsContent);

      console.log(
        `Successfully processed ${this.processedFiles.size} Starknet contracts`,
      );
    } catch (error) {
      console.error('Error processing Starknet artifacts:', error);
      throw error;
    }
  }
}

const generator = new StarknetArtifactGenerator();
generator.generate().catch(console.error);
