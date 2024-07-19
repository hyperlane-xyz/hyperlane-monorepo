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
} from './types.js';

export class ContractVerifier {
  protected logger = rootLogger.child({ module: 'ContractVerifier' });

  protected contractSourceMap: { [contractName: string]: string } = {};

  protected readonly standardInputJson: string;
  protected readonly compilerOptions: CompilerOptions;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly apiKeys: ChainMap<string>,
    buildArtifact: BuildArtifact,
    licenseType: CompilerOptions['licenseType'],
  ) {
    // Extract the standard input json and compiler version from the build artifact
    this.standardInputJson = JSON.stringify(buildArtifact.input);
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
        case ExplorerApiErrors.NOT_VERIFIED:
        case ExplorerApiErrors.PROXY_FAILED:
        case ExplorerApiErrors.BYTECODE_MISMATCH:
          errorMessage = `${responseJson.message}: ${responseJson.result}`;
          break;
        default:
          errorMessage = `Verification failed: ${
            JSON.stringify(responseJson.result) ?? response.statusText
          }`;
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
      const errorMessage = `Verification failed. ${
        JSON.stringify(responseJson.result) ?? response.statusText
      }`;
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

    verificationLogger.debug(
      {
        name: input.name,
        address: input.address,
      },
      `📝 Verifying ${contractType}...`,
    );

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
        {
          guid,
          name: input.name,
          address: input.address,
        },
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
          name: input.name,
          address: input.address,
        },
        `✅ Successfully verified ${contractType}.`,
      );
    } catch (error) {
      verificationLogger.debug(
        {
          name: input.name,
          address: input.address,
          error,
        },
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
    verificationLogger.trace(
      {
        guid,
        name: input.name,
        address: input.address,
      },
      `Checking ${contractType} status...`,
    );
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

    return {
      sourceCode: this.standardInputJson,
      contractname: `${sourceName}:${input.name}`,
      contractaddress: input.address,
      /* TYPO IS ENFORCED BY API */
      constructorArguements: strip0x(input.constructorArguments ?? ''),
      ...this.compilerOptions,
    };
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
}
