import fetch from 'cross-fetch';
import { ethers } from 'ethers';
import { Logger } from 'pino';

import { buildArtifact } from '@hyperlane-xyz/core/buildArtifact-zksync.js';
import { rootLogger } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';

import {
  BuildArtifact,
  ContractVerificationInput,
  SolidityStandardJsonInput,
  ZKSyncCompilerOptions,
} from './types.js';

/**
 * @title ZKSyncContractVerifier
 * @notice Handles the verification of ZKSync contracts on block explorers
 * @dev This class manages the process of verifying ZKSync contracts, including
 * preparing verification data and submitting it to the appropriate explorer API
 */
export class ZKSyncContractVerifier {
  protected logger = rootLogger.child({ module: 'ZKSyncContractVerifier' });

  protected contractSourceMap: { [contractName: string]: string } = {};

  protected readonly standardInputJson: SolidityStandardJsonInput;
  protected readonly compilerOptions: ZKSyncCompilerOptions;

  /**
   * @notice Creates a new ZKSyncContractVerifier instance
   * @param multiProvider An instance of MultiProvider for interacting with multiple chains
   */
  constructor(protected readonly multiProvider: MultiProvider) {
    this.standardInputJson = (buildArtifact as BuildArtifact).input;

    const compilerZksolcVersion = `v${
      (buildArtifact as { zk_version: string }).zk_version
    }`;
    const compilerSolcVersion = (buildArtifact as BuildArtifact)
      .solcLongVersion;

    this.compilerOptions = {
      codeFormat: 'solidity-standard-json-input',
      compilerSolcVersion,
      compilerZksolcVersion,
      optimizationUsed: true,
    };
    void this.createContractSourceMapFromBuildArtifacts();
  }

  /**
   * @notice Creates a mapping of contract names to source names from build artifacts
   * @dev This method processes the input to create a mapping required for constructing fully qualified contract names
   */
  private async createContractSourceMapFromBuildArtifacts() {
    const contractRegex = /contract\s+([A-Z][a-zA-Z0-9]*)/g;
    Object.entries((buildArtifact as BuildArtifact).input.sources).forEach(
      ([sourceName, { content }]) => {
        const matches = content.matchAll(contractRegex);
        for (const match of matches) {
          const contractName = match[1];
          if (contractName) {
            this.contractSourceMap[contractName] = sourceName;
          }
        }
      },
    );
  }

  /**
   * @notice Verifies a contract on the specified chain
   * @param chain The name of the chain where the contract is deployed
   * @param input The contract verification input data
   * @param verificationLogger A logger instance for verification-specific logging
   */
  private async verify(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<void> {
    const contractType: string = input.isProxy ? 'proxy' : 'implementation';

    verificationLogger.debug(`📝 Verifying ${contractType}...`);

    const data = this.getImplementationData(chain, input, verificationLogger);

    try {
      const verificationId: string = await this.submitForm(
        chain,
        verificationLogger,
        data,
      );

      verificationLogger.trace(
        { verificationId },
        `Retrieved verificationId from verified ${contractType}.`,
      );
    } catch (error) {
      verificationLogger.debug(
        { error },
        `Verification of ${contractType} failed`,
      );
      throw error;
    }
  }

  /**
   * @notice Verifies a contract on the specified chain
   * @param chain The name of the chain where the contract is deployed
   * @param input The contract verification input data
   * @param logger An optional logger instance (defaults to the class logger)
   */
  public async verifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
    logger = this.logger,
  ): Promise<void> {
    const verificationLogger = logger.child({
      chain,
      name: input.name,
      address: input.address,
    });

    const metadata = this.multiProvider.tryGetChainMetadata(chain);
    const rpcUrl = metadata?.rpcUrls[0].http ?? '';
    if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) {
      verificationLogger.debug('Skipping verification for local endpoints');
      return;
    }

    const explorerApi = this.multiProvider.tryGetExplorerApi(chain);
    if (!explorerApi) {
      verificationLogger.debug('No explorer API set, skipping');
      return;
    }

    if (!explorerApi.family) {
      verificationLogger.debug(`No explorer family set, skipping`);
      return;
    }

    if (explorerApi.family === ExplorerFamily.Other) {
      verificationLogger.debug(`Unsupported explorer family, skipping`);
      return;
    }

    if (input.address === ethers.constants.AddressZero) return;
    if (Array.isArray(input.constructorArguments)) {
      verificationLogger.debug(
        'Constructor arguments in legacy format, skipping',
      );
      return;
    }

    await this.verify(chain, input, verificationLogger);
  }

  /**
   * @notice Submits the verification form to the explorer API
   * @param chain The name of the chain where the contract is deployed
   * @param verificationLogger A logger instance for verification-specific logging
   * @param options Additional options for the API request
   * @returns The response from the explorer API
   */
  private async submitForm(
    chain: ChainName,
    verificationLogger: Logger,
    options?: Record<string, any>,
  ): Promise<any> {
    const { apiUrl, family } = this.multiProvider.getExplorerApi(chain);

    const url = new URL(apiUrl);
    verificationLogger.trace(
      { apiUrl, chain },
      'Sending request to explorer...',
    );

    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
    let responseJson;
    try {
      responseJson = await response.json();
      verificationLogger.trace(
        { apiUrl, chain },
        'Parsing response from explorer...',
      );
    } catch {
      verificationLogger.trace(
        {
          failure: response.statusText,
          status: response.status,
          chain,
          apiUrl,
          family,
        },
        'Failed to parse response from explorer.',
      );
      throw new Error(
        `Failed to parse response from explorer (${apiUrl}, ${chain}): ${
          response.statusText || 'UNKNOWN STATUS TEXT'
        } (${response.status || 'UNKNOWN STATUS'})`,
      );
    }

    return responseJson;
  }

  /**
   * @notice Prepares the implementation data for contract verification
   * @param chain The name of the chain where the contract is deployed
   * @param input The contract verification input data
   * @param verificationLogger A logger instance for verification-specific logging
   * @returns The prepared implementation data
   */
  private getImplementationData(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ) {
    const sourceName = this.contractSourceMap[input.name];
    if (!sourceName) {
      const errorMessage = `Contract '${input.name}' not found in provided build artifact`;
      verificationLogger.error(errorMessage);
      throw new Error(`[${chain}] ${errorMessage}`);
    }

    const filteredStandardInputJson =
      this.filterStandardInputJsonByContractName(
        input.name,
        this.standardInputJson,
        verificationLogger,
      );

    return {
      sourceCode: filteredStandardInputJson,
      contractName: `${sourceName}:${input.name}`,
      contractAddress: input.address,
      constructorArguments: `0x${input.constructorArguments || ''}`,
      ...this.compilerOptions,
    };
  }

  /**
   * @notice Filters the solidity standard input for a specific contract name
   * @dev This is a BFS implementation to traverse the source input dependency graph
   * @param contractName The name of the contract to filter for
   * @param input The full solidity standard input
   * @param verificationLogger A logger instance for verification-specific logging
   * @returns The filtered solidity standard input
   */
  private filterStandardInputJsonByContractName(
    contractName: string,
    input: SolidityStandardJsonInput,
    verificationLogger: Logger,
  ): SolidityStandardJsonInput {
    verificationLogger.trace(
      { contractName },
      'Filtering unused contracts from solidity standard input JSON....',
    );
    const filteredSources: SolidityStandardJsonInput['sources'] = {};
    const sourceFiles: string[] = Object.keys(input.sources);
    const contractFile: string = this.contractSourceMap[contractName];
    const queue: string[] = [contractFile];
    const processed = new Set<string>();

    while (queue.length > 0) {
      const file = queue.shift()!;
      if (processed.has(file)) continue;
      processed.add(file);

      filteredSources[file] = input.sources[file];

      const content = input.sources[file].content;
      const importStatements = this.getAllImportStatements(content);

      importStatements.forEach((importStatement) => {
        const importPath = importStatement.match(/["']([^"']+)["']/)?.[1];
        if (importPath) {
          const resolvedPath = this.resolveImportPath(file, importPath);
          if (sourceFiles.includes(resolvedPath)) queue.push(resolvedPath);
        }
      });
    }

    return {
      ...input,
      sources: filteredSources,
    };
  }

  /**
   * @notice Extracts all import statements from a given content string
   * @param content The content string to search for import statements
   * @returns An array of import statements found in the content
   */
  private getAllImportStatements(content: string) {
    const importRegex =
      /import\s+(?:(?:(?:"[^"]+"|'[^']+')\s*;)|(?:{[^}]+}\s+from\s+(?:"[^"]+"|'[^']+')\s*;)|(?:\s*(?:"[^"]+"|'[^']+')\s*;))/g;
    return content.match(importRegex) || [];
  }

  /**
   * @notice Resolves an import path relative to the current file
   * @param currentFile The path of the current file
   * @param importPath The import path to resolve
   * @returns The resolved import path
   */
  private resolveImportPath(currentFile: string, importPath: string): string {
    /* Use as-is for external dependencies and absolute imports */
    if (importPath.startsWith('@') || importPath.startsWith('http')) {
      return importPath;
    }
    const currentDir = currentFile.split('/').slice(0, -1).join('/');
    const resolvedPath = importPath.split('/').reduce((acc, part) => {
      if (part === '..') {
        acc.pop();
      } else if (part !== '.') {
        acc.push(part);
      }
      return acc;
    }, currentDir.split('/'));
    return resolvedPath.join('/');
  }
}
