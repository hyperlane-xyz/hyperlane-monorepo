import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { sleep, strip0x } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';

import {
  BuildArtifact,
  CompilerOptions,
  ContractVerificationInput,
  ExplorerApiActions,
  ExplorerApiErrors,
  FormOptions,
} from './types';

export class ContractVerifier {
  private logger = debug(`hyperlane:ContractVerifier`);

  private contractMap: { [contractName: string]: string } = {};

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
          if (match[1]) {
            this.contractMap[match[1]] = sourceName;
          }
        }
      },
    );
  }

  private async submitForm(
    chain: ChainName,
    action: ExplorerApiActions,
    verificationLogger: Debugger,
    options?: FormOptions<typeof action>,
  ): Promise<any> {
    const { apiUrl, family } = this.multiProvider.getExplorerApi(chain);
    const params = new URLSearchParams();
    params.set('module', 'contract');
    params.set('action', action);

    // no need to provide every argument for every request
    if (options) {
      for (const [key, value] of Object.entries(options)) {
        params.set(key, value);
      }
    }

    // only include apikey if provided & not blockscout
    if (family !== ExplorerFamily.Blockscout && this.apiKeys[chain]) {
      params.set('apikey', this.apiKeys[chain]);
    }

    const url = new URL(apiUrl);
    const isGetRequest = [
      ExplorerApiActions.CHECK_STATUS,
      ExplorerApiActions.CHECK_PROXY_STATUS,
      ExplorerApiActions.GETSOURCECODE,
    ].includes(action);
    if (isGetRequest) {
      url.search = params.toString();
    } else if (family === ExplorerFamily.Blockscout) {
      // Blockscout requires module and action to be query params
      url.searchParams.set('module', 'contract');
      url.searchParams.set('action', action);
    }

    const response = await fetch(url.toString(), {
      method: isGetRequest ? 'GET' : 'POST',
      headers: isGetRequest
        ? {}
        : { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: isGetRequest ? null : params,
    });

    const responseText = await response.text();
    const result = JSON.parse(responseText);

    if (result.message !== 'OK') {
      let errorMessage;

      switch (result.result) {
        case ExplorerApiErrors.VERIFICATION_PENDING:
          await sleep(5000); // wait 5 seconds
          return this.submitForm(chain, action, verificationLogger, options);
        case ExplorerApiErrors.ALREADY_VERIFIED:
        case ExplorerApiErrors.ALREADY_VERIFIED_ALT:
          return;
        case ExplorerApiErrors.PROXY_FAILED:
          errorMessage = 'Proxy verification failed, try manually?';
          break;
        case ExplorerApiErrors.BYTECODE_MISMATCH:
          errorMessage =
            'Compiled bytecode does not match deployed bytecode, check constructor arguments?';
          break;
        default:
          errorMessage = `Verification failed. ${
            result.result ?? response.statusText
          }`;
          break;
      }

      if (errorMessage) {
        verificationLogger(errorMessage);
        throw new Error(`[${chain}] ${errorMessage}`);
      }
    }

    if (result.result === ExplorerApiErrors.UNKNOWN_UID) {
      await sleep(1000); // wait 1 second
      return this.submitForm(chain, action, verificationLogger, options);
    }

    if (result.result === ExplorerApiErrors.UNABLE_TO_VERIFY) {
      const errorMessage = `Verification failed. ${
        result.result ?? response.statusText
      }`;
      verificationLogger(errorMessage);
      throw new Error(`[${chain}] ${errorMessage}`);
    }

    return result.result;
  }

  private async isAlreadyVerified(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Debugger,
  ): Promise<boolean> {
    try {
      const result = await this.submitForm(
        chain,
        ExplorerApiActions.GETSOURCECODE,
        verificationLogger,
        {
          address: input.address,
        },
      );
      return !!result[0]?.SourceCode;
    } catch (error) {
      verificationLogger(
        `Error checking if contract is already verified: ${error}`,
      );
      return false;
    }
  }

  private async verifyProxy(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Debugger,
  ): Promise<void> {
    if (!input.isProxy) return;

    try {
      const proxyGuid = await this.submitForm(
        chain,
        ExplorerApiActions.MARK_PROXY,
        verificationLogger,
        { address: input.address },
      );
      if (!proxyGuid) return;

      await this.submitForm(
        chain,
        ExplorerApiActions.CHECK_PROXY_STATUS,
        verificationLogger,
        {
          guid: proxyGuid,
        },
      );
      const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
        input.address,
      );
      verificationLogger(
        `Successfully verified proxy ${addressUrl}#readProxyContract`,
      );
    } catch (error) {
      verificationLogger(
        `Verification of proxy at ${input.address} failed: ${error}`,
      );
      throw error;
    }
  }

  private async verifyImplementation(
    chain: ChainName,
    input: ContractVerificationInput,
    verificationLogger: Debugger,
  ): Promise<void> {
    verificationLogger(`Verifying implementation at ${input.address}`);

    const sourceName = this.contractMap[input.name];
    if (!sourceName) {
      const errorMessage = `Contract '${input.name}' not found in provided build artifact`;
      verificationLogger(errorMessage);
      throw new Error(`[${chain}] ${errorMessage}`);
    }

    const data = {
      sourceCode: this.standardInputJson,
      contractname: `${sourceName}:${input.name}`,
      contractaddress: input.address,
      // TYPO IS ENFORCED BY API
      constructorArguements: strip0x(input.constructorArguments ?? ''),
      ...this.compilerOptions,
    };

    const guid = await this.submitForm(
      chain,
      ExplorerApiActions.VERIFY_IMPLEMENTATION,
      verificationLogger,
      data,
    );
    if (!guid) return;

    await this.submitForm(
      chain,
      ExplorerApiActions.CHECK_STATUS,
      verificationLogger,
      { guid },
    );
    const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
      chain,
      input.address,
    );
    verificationLogger(`Successfully verified ${addressUrl}#code`);
  }

  async verifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
    logger = this.logger,
  ): Promise<void> {
    const verificationLogger = logger.extend(`${chain}:${input.name}`);

    const explorerApi = this.multiProvider.tryGetExplorerApi(chain);
    if (!explorerApi) {
      verificationLogger('No explorer API set, skipping');
      return;
    }

    if (!explorerApi.family) {
      verificationLogger(`No explorer family set, skipping`);
      return;
    }

    if (explorerApi.family === ExplorerFamily.Other) {
      verificationLogger(`Unsupported explorer family, skipping`);
      return;
    }

    if (input.address === ethers.constants.AddressZero) return;
    if (Array.isArray(input.constructorArguments)) {
      verificationLogger('Constructor arguments in legacy format, skipping');
      return;
    }

    if (await this.isAlreadyVerified(chain, input, verificationLogger)) {
      const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
        input.address,
      );
      verificationLogger(`Contract already verified at ${addressUrl}#code`);
      await sleep(200); // There is a rate limit of 5 requests per second
      return;
    }

    await this.verifyImplementation(chain, input, verificationLogger);
    await this.verifyProxy(chain, input, verificationLogger);
  }
}
