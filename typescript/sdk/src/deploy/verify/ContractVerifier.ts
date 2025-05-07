import fetch from 'cross-fetch';
import { ethers } from 'ethers';
import { Logger } from 'pino';

import { rootLogger, sleep, strip0x } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../../types.js';

import {
  BuildArtifact,
  CompilerOptions,
  ContractVerificationInput,
  EXPLORER_GET_ACTIONS,
  ExplorerApiActions,
  ExplorerApiErrors,
  FormOptions,
  SolidityStandardJsonInput,
} from './types.js';

export class ContractVerifier {
  protected logger = rootLogger.child({ module: 'ContractVerifier' });

  protected contractSourceMap: { [contractName: string]: string } = {};

  protected readonly standardInputJson: SolidityStandardJsonInput;
  protected readonly compilerOptions: CompilerOptions;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly apiKeys: ChainMap<string>,
    buildArtifact: BuildArtifact,
    licenseType: CompilerOptions['licenseType'],
  ) {
    this.standardInputJson = buildArtifact.input;

    const compilerversion = `v${buildArtifact.solcLongVersion}`;

    // double check compiler version matches expected format
    const versionRegex = /v(\d.\d.\d+)\+commit.\w+/;
    const matches = versionRegex.exec(compilerversion);
    if (!matches) {
      throw new Error(`Invalid compiler version ${compilerversion}`);
    }

    // set compiler options
    // only license type is configurable, empty if not provided
    this.compilerOptions = {
      codeformat: 'solidity-standard-json-input',
      compilerversion,
      licenseType,
    };

    // process input to create mapping of contract names to source names
    // this is required to construct the fully qualified contract name
    const contractRegex = /contract\s+([A-Z][a-zA-Z0-9]*)/g;
    Object.entries(buildArtifact.input.sources).forEach(
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
    action: ExplorerApiActions,
    verificationLogger: Logger,
    options?: FormOptions<typeof action>,
  ): Promise<any> {
    const {
      apiUrl,
      family,
      apiKey = this.apiKeys[chain],
    } = this.multiProvider.getExplorerApi(chain);
    const params = new URLSearchParams();

    params.set('module', 'contract');
    params.set('action', action);
    if (apiKey) params.set('apikey', apiKey);

    for (const [key, value] of Object.entries(options ?? {})) {
      params.set(key, value);
    }

    let timeout: number = 1000;
    const url = new URL(apiUrl);
    const isGetRequest = EXPLORER_GET_ACTIONS.includes(action);
    if (isGetRequest) url.search = params.toString();

    switch (family) {
      case ExplorerFamily.Etherscan:
        timeout = 5000;
        break;
      case ExplorerFamily.Blockscout:
        timeout = 1000;
        url.searchParams.set('module', 'contract');
        url.searchParams.set('action', action);
        break;
      case ExplorerFamily.Routescan:
        timeout = 500;
        break;
      case ExplorerFamily.Other:
      default:
        throw new Error(
          `Unsupported explorer family: ${family}, ${chain}, ${apiUrl}`,
        );
    }

    verificationLogger.trace(
      { apiUrl, chain },
      'Sending request to explorer...',
    );
    let response: Response;
    if (isGetRequest) {
      response = await fetch(url.toString(), {
        method: 'GET',
      });
    } else {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      };
      response = await fetch(url.toString(), init);
    }
    let responseJson;
    try {
      const responseTextString = await response.text();
      verificationLogger.trace(
        { apiUrl, chain },
        'Parsing response from explorer...',
      );
      responseJson = JSON.parse(responseTextString);
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

    if (responseJson.message !== 'OK') {
      let errorMessage;

      switch (responseJson.result) {
        case ExplorerApiErrors.VERIFICATION_PENDING:
          verificationLogger.trace(
            {
              result: responseJson.result,
            },
            'Verification still pending',
          );
          await sleep(timeout);
          return this.submitForm(chain, action, verificationLogger, options);
        case ExplorerApiErrors.ALREADY_VERIFIED:
        case ExplorerApiErrors.ALREADY_VERIFIED_ALT:
          break;
        case ExplorerApiErrors.NOT_VERIFIED:
        case ExplorerApiErrors.PROXY_FAILED:
        case ExplorerApiErrors.BYTECODE_MISMATCH:
          errorMessage = `${responseJson.message}: ${responseJson.result}`;
          break;
        default:
          errorMessage = `Verification failed: ${JSON.stringify(
            responseJson.result ?? response.statusText,
          )}`;
          break;
      }

      if (errorMessage) {
        verificationLogger.debug(errorMessage);
        throw new Error(`[${chain}] ${errorMessage}`);
      }
    }

    if (responseJson.result === ExplorerApiErrors.UNKNOWN_UID) {
      await sleep(timeout);
      return this.submitForm(chain, action, verificationLogger, options);
    }

    if (responseJson.result === ExplorerApiErrors.UNABLE_TO_VERIFY) {
      const errorMessage = `Verification failed. ${JSON.stringify(
        responseJson.result ?? response.statusText,
      )}`;
      verificationLogger.debug(errorMessage);
      throw new Error(`[${chain}] ${errorMessage}`);
    }

    verificationLogger.trace(
      { apiUrl, chain, result: responseJson.result },
      'Returning result from explorer.',
    );

    await sleep(timeout);
    return responseJson.result;
  }

  private async verify(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
  ): Promise<void> {
    const contractType: string = input.isProxy ? 'proxy' : 'implementation';

    verificationLogger.debug(`📝 Verifying ${contractType}...`);

    const data = input.isProxy
      ? this.getProxyData(input)
      : this.getImplementationData(chain, input, verificationLogger);

    try {
      const guid: string = await this.submitForm(
        chain,
        input.isProxy
          ? ExplorerApiActions.VERIFY_PROXY
          : ExplorerApiActions.VERIFY_IMPLEMENTATION,
        verificationLogger,
        data,
      );

      verificationLogger.trace(
        { guid },
        `Retrieved guid from verified ${contractType}.`,
      );

      await this.checkStatus(
        chain,
        input,
        verificationLogger,
        guid,
        contractType,
      );

      const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
        input.address,
      );

      verificationLogger.debug(
        {
          addressUrl: addressUrl
            ? `${addressUrl}#code`
            : `Could not retrieve ${contractType} explorer URL.`,
        },
        `✅ Successfully verified ${contractType}.`,
      );
    } catch (error) {
      verificationLogger.debug(
        { error },
        `Verification of ${contractType} failed`,
      );
      throw error;
    }
  }

  private async checkStatus(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Logger,
    guid: string,
    contractType: string,
  ): Promise<void> {
    verificationLogger.trace({ guid }, `Checking ${contractType} status...`);
    await this.submitForm(
      chain,
      input.isProxy
        ? ExplorerApiActions.CHECK_PROXY_STATUS
        : ExplorerApiActions.CHECK_IMPLEMENTATION_STATUS,
      verificationLogger,
      {
        guid: guid,
      },
    );
  }

  async getVerifiedContractSourceCode() {}

  private getProxyData(input: ContractVerificationInput) {
    return {
      address: input.address,
      expectedimplementation: input.expectedimplementation,
    };
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
      sourceCode: JSON.stringify(filteredStandardInputJson),
      contractname: `${sourceName}:${input.name}`,
      contractaddress: input.address,
      /* TYPO IS ENFORCED BY API */
      constructorArguements: strip0x(input.constructorArguments ?? ''),
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
    const contractFile: string = this.getContractFile(
      contractName,
      sourceFiles,
    );
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

  private getContractFile(contractName: string, sourceFiles: string[]): string {
    const contractFile = sourceFiles.find((file) =>
      file.endsWith(`/${contractName}.sol`),
    );
    if (!contractFile) {
      throw new Error(`Contract ${contractName} not found in sources.`);
    }
    return contractFile;
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
