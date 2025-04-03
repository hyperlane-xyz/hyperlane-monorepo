import { promises as fs } from 'fs';
import { globby } from 'globby';
import { basename, dirname, join } from 'path';
import { CompiledContract } from 'starknet';
import { fileURLToPath } from 'url';

import { CONFIG } from '../src/config.js';

const cwd = process.cwd();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT_OUTPUT_DIR = join(__dirname, '../dist/artifacts/');
const RELEASE_DIR = join(cwd, 'release');

enum ContractClass {
  SIERRA = 'contract_class',
  CASM = 'compiled_contract_class',
}

/**
 * @notice Contract categories based on prefix
 */
enum ContractType {
  CONTRACT = 'contracts_',
  TOKEN = 'token_',
  MOCK = 'mock_',
}

/**
 * @notice Templates for TypeScript artifact generation
 */
const TEMPLATES = {
  JS_ARTIFACT: `\
export const {name} = {artifact};
`,

  DTS_ARTIFACT: `\
import type { CompiledContract, CairoAssembly } from 'starknet';

export declare const {name}: {type};
`,

  JS_INDEX: `\
{imports}

export const starknetContracts = {
  contracts: {
{contractExports}
  },
  tokens: {
{tokenExports}
  },
  mocks: {
{mockExports}
  }
};
`,

  DTS_INDEX: `\
import type { CompiledContract, CairoAssembly } from 'starknet';

export interface StarknetContractGroup {
  [name: string]: {
    contract_class?: CompiledContract;
    compiled_contract_class?: CairoAssembly;
  };
}

export interface StarknetContracts {
  contracts: StarknetContractGroup;
  tokens: StarknetContractGroup;
  mocks: StarknetContractGroup;
}

export declare const starknetContracts: StarknetContracts;
`,
};

class StarknetArtifactGenerator {
  private processedFiles: Map<
    string,
    { type: ContractType; sierra: boolean; casm: boolean }
  >;
  private contractExports: string[] = [];
  private tokenExports: string[] = [];
  private mockExports: string[] = [];

  constructor() {
    this.processedFiles = new Map();
  }

  getContractTypeFromPath(filePath: string): ContractType {
    const fileName = basename(filePath);
    // Check for exact prefix matches to avoid double categorization
    if (fileName.startsWith('token_')) return ContractType.TOKEN;
    if (fileName.startsWith('mock_') || fileName.startsWith('mocks_'))
      return ContractType.MOCK;
    if (fileName.startsWith('contracts_')) return ContractType.CONTRACT;
    return ContractType.CONTRACT; // default case
  }

  getContractClassFromPath(filePath: string): ContractClass {
    return filePath.includes('compiled_contract_class')
      ? ContractClass.CASM
      : ContractClass.SIERRA;
  }

  /**
   * @notice Retrieves paths of all relevant artifact files
   */
  async getArtifactPaths() {
    const sierraPattern = `${RELEASE_DIR}/**/*${CONFIG.CONTRACT_FILE_SUFFIXES.SIERRA_JSON}`;
    const [sierraFiles] = await Promise.all([globby(sierraPattern)]);
    return { sierraFiles };
  }

  /**
   * @notice Creates the output directory if it doesn't exist
   */
  async createOutputDirectory() {
    await fs.mkdir(ROOT_OUTPUT_DIR, { recursive: true });
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

      return TEMPLATES.JS_ARTIFACT.replace('{name}', name).replace(
        '{artifact}',
        JSON.stringify(abiOnly),
      );
    }
    // For other contract types, return the full artifact
    return TEMPLATES.JS_ARTIFACT.replace('{name}', name).replace(
      '{artifact}',
      JSON.stringify(artifact),
    );
  }

  /**
   * @notice Generates TypeScript declaration content for a contract artifact
   */
  generateDeclarationContent(name: string, isSierra: boolean) {
    const type = isSierra ? 'CompiledContract' : 'CairoAssembly';
    return TEMPLATES.DTS_ARTIFACT.replace('{name}', name).replace(
      '{type}',
      type,
    );
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
      const baseName = name.replace(
        new RegExp(`^(${Object.values(ContractType).join('|')})`),
        '',
      );

      if (value.sierra) {
        // Add prefix to avoid naming conflicts
        const sierraVarName = `${value.type}${baseName}Sierra`;
        imports.push(
          `import { ${name} as ${sierraVarName} } from './${name}.${ContractClass.SIERRA}.js';`,
        );

        const exportLine = `    ${baseName}: { contract_class: ${sierraVarName}`;
        const targetExports = this.getExportArrayForType(value.type);
        targetExports.push(value.casm ? `${exportLine},` : `${exportLine} },`);
      }

      if (value.casm) {
        // Add prefix to avoid naming conflicts
        const casmVarName = `${value.type}${baseName}Casm`;
        imports.push(
          `import { ${name} as ${casmVarName} } from './${name}.${ContractClass.CASM}.js';`,
        );

        const exportLine = value.sierra
          ? `      compiled_contract_class: ${casmVarName} },`
          : `    ${baseName}: { compiled_contract_class: ${casmVarName} },`;

        this.getExportArrayForType(value.type).push(exportLine);
      }
    });

    return {
      jsContent: TEMPLATES.JS_INDEX.replace('{imports}', imports.join('\n'))
        .replace('{contractExports}', this.contractExports.join('\n'))
        .replace('{tokenExports}', this.tokenExports.join('\n'))
        .replace('{mockExports}', this.mockExports.join('\n')),
      dtsContent: TEMPLATES.DTS_INDEX,
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
      join(ROOT_OUTPUT_DIR, outputFileName + '.js'),
      jsContent,
    );
    await fs.writeFile(
      join(ROOT_OUTPUT_DIR, outputFileName + '.d.ts'),
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
      await fs.writeFile(join(ROOT_OUTPUT_DIR, 'index.js'), jsContent);
      await fs.writeFile(join(ROOT_OUTPUT_DIR, 'index.d.ts'), dtsContent);

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
