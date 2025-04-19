import { Logger } from 'pino';

import { isZeroishAddress, rootLogger, sleep } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainName } from '../../types.js';

import {
  BuildArtifact,
  ContractVerificationInput,
  SolidityStandardJsonInput,
} from './types.js';
import { FamilyVerificationDelay } from './utils.js';

export abstract class BaseContractVerifier {
  protected logger = rootLogger.child({ module: this.constructor.name });
  protected contractSourceMap: { [contractName: string]: string } = {};
  protected readonly standardInputJson: SolidityStandardJsonInput;

  constructor(
    protected readonly multiProvider: MultiProvider,
    buildArtifact: BuildArtifact,
  ) {
    this.standardInputJson = buildArtifact.input;
    this.createContractSourceMapFromBuildArtifacts();
  }

  protected createContractSourceMapFromBuildArtifacts(): void {
    const contractRegex = /contract\s+([A-Z][a-zA-Z0-9]*)/g;
    Object.entries(this.standardInputJson.sources).forEach(
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

    if (!this.shouldVerifyContract(chain, input, verificationLogger)) {
      return;
    }

    const explorerApi = this.multiProvider.tryGetExplorerApi(chain);

    await sleep(
      FamilyVerificationDelay[
        explorerApi?.family as keyof typeof FamilyVerificationDelay
      ] ?? 0,
    );
    await this.verify(chain, input, verificationLogger);
  }

  protected shouldVerifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): boolean {
    const metadata = this.multiProvider.tryGetChainMetadata(chain);
    const rpcUrl = metadata?.rpcUrls[0].http ?? '';
    if (rpcUrl.includes('localhost') || rpcUrl.includes('127.0.0.1')) {
      verificationLogger.debug('Skipping verification for local endpoints');
      return false;
    }

    const explorerApi = this.multiProvider.tryGetExplorerApi(chain);
    if (!explorerApi) {
      verificationLogger.debug('No explorer API set, skipping');
      return false;
    }

    if (!explorerApi.family) {
      verificationLogger.debug(`No explorer family set, skipping`);
      return false;
    }

    if (explorerApi.family === ExplorerFamily.Other) {
      verificationLogger.debug(`Unsupported explorer family, skipping`);
      return false;
    }

    if (isZeroishAddress(input.address)) return false;
    if (Array.isArray(input.constructorArguments)) {
      verificationLogger.debug(
        'Constructor arguments in legacy format, skipping',
      );
      return false;
    }

    return true;
  }

  protected abstract verify(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<void>;

  protected getImplementationData(
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

    return this.prepareImplementationData(
      sourceName,
      input,
      filteredStandardInputJson,
    );
  }

  protected abstract prepareImplementationData(
    sourceName: string,
    input: ContractVerificationInput,
    filteredStandardInputJson: SolidityStandardJsonInput,
  ): any;

  protected filterStandardInputJsonByContractName(
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

  protected getAllImportStatements(content: string): string[] {
    const importRegex =
      /import\s+(?:(?:(?:"[^"]+"|'[^']+')\s*;)|(?:{[^}]+}\s+from\s+(?:"[^"]+"|'[^']+')\s*;)|(?:\s*(?:"[^"]+"|'[^']+')\s*;))/g;
    return content.match(importRegex) || [];
  }

  protected resolveImportPath(currentFile: string, importPath: string): string {
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
