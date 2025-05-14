import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { globby } from 'globby';
import { basename, join } from 'path';

import { CONTRACT_SUFFIXES } from '../src/const.js';
import { ContractClass, ContractType } from '../src/types.js';

import { Templates } from './Templates.js';
import { prettierOutputTransformer } from './prettier.js';

type ProcessedFileInfo = { type: ContractType; sierra: boolean; casm: boolean };
type ProcessedFilesMap = Map<string, ProcessedFileInfo>;
export type ReadonlyProcessedFilesMap = ReadonlyMap<string, ProcessedFileInfo>;

export class StarknetArtifactGenerator {
  private compiledContractsDir: string;
  private rootOutputDir: string;

  constructor(compiledContractsDir: string, rootOutputDir: string) {
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
    const casmPattern = `${this.compiledContractsDir}/**/*${CONTRACT_SUFFIXES.ASSEMBLY_JSON}`;
    const [sierraFiles, casmFiles] = await Promise.all([
      globby(sierraPattern),
      globby(casmPattern),
    ]);
    return { sierraFiles, casmFiles };
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
   * @notice Generates index file contents with categorized contracts
   */
  generateIndexContents(processedFilesMap: ReadonlyProcessedFilesMap): {
    tsContent: string;
  } {
    const imports: string[] = [];
    const contractExports: string[] = [];
    const tokenExports: string[] = [];
    const mockExports: string[] = [];

    processedFilesMap.forEach((value, name) => {
      // Extracts the contract name by removing the prefix (contracts_, token_, or mocks_)
      // Example: "token_HypErc20" becomes "HypErc20"
      const baseName = name.replace(
        new RegExp(`^(${Object.values(ContractType).join('|')})_?`),
        '',
      );

      let sierraVarName: string | undefined;
      let abiVarName: string | undefined;
      let casmVarName: string | undefined;

      if (value.sierra) {
        sierraVarName = `${value.type}_${baseName}_sierra`;
        imports.push(
          `const ${sierraVarName} = require('../contracts/${name}.${ContractClass.SIERRA}.json');`,
        );
        abiVarName = `${value.type}_${baseName}_abi`;
        imports.push(
          `import { ABI as ${abiVarName} } from './${name}_abi.js';`,
        );
      }

      if (value.casm) {
        casmVarName = `${value.type}_${baseName}_casm`;
        imports.push(
          `const ${casmVarName} = require('../contracts/${name}.${ContractClass.CASM}.json');`,
        );
      }

      // exports with type guard filter
      const exports = [
        sierraVarName ? `contract_class: ${sierraVarName}` : null,
        abiVarName ? `contract_abi: ${abiVarName}` : null,
        casmVarName ? `compiled_contract_class: ${casmVarName}` : null,
      ].filter((e): e is string => e !== null);

      const exportString = `${baseName}: { ${exports.join(', ')} },`;

      switch (value.type) {
        case ContractType.TOKEN:
          tokenExports.push(exportString);
          break;
        case ContractType.MOCK:
          mockExports.push(exportString);
          break;
        default: // ContractType.CONTRACT
          contractExports.push(exportString);
          break;
      }
    });

    return {
      tsContent: Templates.tsIndex(
        imports.join('\n'),
        contractExports,
        tokenExports,
        mockExports,
      ),
    };
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

    return { name, contractType, contractClass };
  }

  /**
   * @notice Processes all ABI files
   */
  async processAbis(files: string[]) {
    for (const filePath of files) {
      const baseFileName = basename(filePath);
      const name = baseFileName
        .replace('.json', '')
        .replace(`.${ContractClass.SIERRA}`, '')
        .replace(`.${ContractClass.CASM}`, '');

      console.log(
        `npx abi-wan-kanabi --input ${filePath} --output ${this.rootOutputDir}${name}_abi.ts`,
      );
      execSync(
        `npx abi-wan-kanabi --input ${filePath} --output ${this.rootOutputDir}${name}_abi.ts`,
      );
    }
  }

  private _aggregateProcessingResults(
    processingResults: Array<{
      name: string;
      contractType: ContractType;
      contractClass: ContractClass;
    }>,
  ): ProcessedFilesMap {
    const processedFilesMap = new Map<string, ProcessedFileInfo>();
    for (const result of processingResults) {
      const fileInfo = processedFilesMap.get(result.name) || {
        type: result.contractType,
        sierra: false,
        casm: false,
      };

      if (result.contractClass === ContractClass.SIERRA) {
        fileInfo.sierra = true;
      } else {
        fileInfo.casm = true;
      }
      processedFilesMap.set(result.name, fileInfo);
    }
    return processedFilesMap;
  }

  async generate(): Promise<ReadonlyProcessedFilesMap> {
    try {
      await this.createOutputDirectory();

      const { sierraFiles, casmFiles } = await this.getArtifactPaths();

      await this.processAbis(sierraFiles);

      const processingResults = await Promise.all([
        ...sierraFiles.map((file) => this.processArtifact(file)),
        ...casmFiles.map((file) => this.processArtifact(file)),
      ]);

      const processedFilesMap =
        this._aggregateProcessingResults(processingResults);

      const { tsContent } = this.generateIndexContents(processedFilesMap);

      await fs.writeFile(
        join(this.rootOutputDir, 'index.ts'),
        await prettierOutputTransformer(tsContent),
      );

      return processedFilesMap;
    } catch (error) {
      throw error;
    }
  }
}
