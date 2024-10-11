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

export class ZKSyncContractVerifier {
  protected logger = rootLogger.child({ module: 'ZKSyncContractVerifier' });

  protected contractSourceMap: { [contractName: string]: string } = {};

  protected readonly standardInputJson: SolidityStandardJsonInput;
  // ZK  CompilerOptions
  protected readonly compilerOptions: ZKSyncCompilerOptions;

  constructor(protected readonly multiProvider: MultiProvider) {
    this.standardInputJson = (buildArtifact as BuildArtifact).input;

    const compilerZksolcVersion = `v${
      (buildArtifact as { zk_version: string }).zk_version
    }`;
    const compilerSolcVersion = (buildArtifact as BuildArtifact)
      .solcLongVersion;

    // set compiler options
    // only license type is configurable, empty if not provided
    this.compilerOptions = {
      codeFormat: 'solidity-standard-json-input',
      compilerSolcVersion,
      compilerZksolcVersion,
      optimizationUsed: true,
    };
    this.createContractSourceMapFromBuildArtifacts();
  }
  // process input to create mapping of contract names to source names
  // this is required to construct the fully qualified contract name
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

    let response: Response;

    response = await fetch(url.toString(), {
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
    } catch (error) {
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
      /* TYPO IS ENFORCED BY API */
      constructorArguments: `0x${input.constructorArguments || ''}`,
      ...this.compilerOptions,
    };
  }

  /**
   * Filters the solidity standard input for a specific contract name.
   *
   * This is a BFS impl to traverse the source input dependency graph.
   * 1. Named contract file is set as root node.
   * 2. The next level is formed by the direct imports of the contract file.
   * 3. Each subsequent level's dependencies form the next level, etc.
   * 4. The queue tracks the next files to process, and ensures the dependency graph explorered level by level.
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

  private getAllImportStatements(content: string) {
    const importRegex =
      /import\s+(?:(?:(?:"[^"]+"|'[^']+')\s*;)|(?:{[^}]+}\s+from\s+(?:"[^"]+"|'[^']+')\s*;)|(?:\s*(?:"[^"]+"|'[^']+')\s*;))/g;
    return content.match(importRegex) || [];
  }

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
