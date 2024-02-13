import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { sleep, strip0x } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';

import {
  CompilerOptions,
  ContractVerificationInput,
  ExplorerApiActions,
  ExplorerApiErrors,
  FormOptions,
} from './types';

export class ContractVerifier {
  private logger = debug(`hyperlane:ContractVerifier`);
  private compilerOptions: CompilerOptions;

  constructor(
    protected readonly multiProvider: MultiProvider,
    protected readonly apiKeys: ChainMap<string>,
    protected readonly source: string, // solidity standard input json
    compilerOptions: Partial<Omit<CompilerOptions, 'codeformat'>>,
  ) {
    this.compilerOptions = {
      codeformat: 'solidity-standard-json-input',
      compilerversion:
        compilerOptions?.compilerversion ?? 'v0.8.19+commit.7dd6d404',
      licenseType: compilerOptions?.licenseType,
    };
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

    // only include apikey if provided
    if (this.apiKeys[chain]) {
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

    const data = {
      sourceCode: this.source,
      contractname: input.name,
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
