import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'ethers';

import { sleep, strip0x } from '@hyperlane-xyz/utils';

import { ExplorerFamily } from '../../metadata/chainMetadataTypes';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { MultiGeneric } from '../../utils/MultiGeneric';

import {
  CompilerOptions,
  ContractVerificationInput,
  VerificationInput,
} from './types';

enum ExplorerApiActions {
  GETSOURCECODE = 'getsourcecode',
  VERIFY_IMPLEMENTATION = 'verifysourcecode',
  MARK_PROXY = 'verifyproxycontract',
  CHECK_STATUS = 'checkverifystatus',
  CHECK_PROXY_STATUS = 'checkproxyverification',
}

enum ExplorerApiErrors {
  ALREADY_VERIFIED = 'Contract source code already verified',
  ALREADY_VERIFIED_ALT = 'Already Verified',
  VERIFICATION_PENDING = 'Pending in queue',
  PROXY_FAILED = 'A corresponding implementation contract was unfortunately not detected for the proxy address.',
  BYTECODE_MISMATCH = 'Fail - Unable to verify. Compiled contract deployment bytecode does NOT match the transaction deployment bytecode.',
}

export class ContractVerifier extends MultiGeneric<VerificationInput> {
  protected logger: Debugger;

  constructor(
    verificationInputs: ChainMap<VerificationInput>,
    protected readonly multiProvider: MultiProvider,
    protected readonly apiKeys: ChainMap<string>,
    protected readonly flattenedSource: string, // flattened source code from eg `hardhat flatten`
    protected readonly compilerOptions: CompilerOptions,
  ) {
    super(verificationInputs);
    this.logger = debug('hyperlane:ContractVerifier');
  }

  verify(targets = this.chains()): Promise<PromiseSettledResult<void>[]> {
    return Promise.allSettled(
      targets.map((chain) => this.verifyChain(chain, this.get(chain))),
    );
  }

  async verifyChain(
    chain: ChainName,
    inputs: VerificationInput,
  ): Promise<void> {
    this.logger(`Verifying ${chain}...`);
    for (const input of inputs) {
      await this.verifyContract(chain, input);
    }
  }

  private async submitForm(
    chain: ChainName,
    action: ExplorerApiActions,
    options?: Record<string, string>,
  ): Promise<any> {
    const { apiUrl, family } = this.multiProvider.getExplorerApi(chain);
    if (family === ExplorerFamily.Other) {
      this.logger(`[${chain}] Unsupported explorer: ${apiUrl}`);
      return {};
    }

    const isGetRequest =
      action === ExplorerApiActions.CHECK_STATUS ||
      action === ExplorerApiActions.CHECK_PROXY_STATUS ||
      action === ExplorerApiActions.GETSOURCECODE;
    const params = new URLSearchParams({
      apikey: this.apiKeys[chain],
      module: 'contract',
      action,
      ...options,
    });

    let response: Response;
    if (isGetRequest) {
      response = await fetch(`${apiUrl}?${params}`);
    } else {
      response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
    }

    let result;
    let responseText;
    try {
      responseText = await response.text();
      result = JSON.parse(responseText);
    } catch (e) {
      this.logger(
        `[${chain}] Failed to parse response from ${responseText}`,
        e,
      );
    }
    if (result.message !== 'OK') {
      const errorMessageBase = `[${chain}]`;
      let errorMessage;

      switch (result.result) {
        case ExplorerApiErrors.VERIFICATION_PENDING:
          await sleep(5000); // wait 5 seconds
          return this.submitForm(chain, action, options);
        case ExplorerApiErrors.ALREADY_VERIFIED:
        case ExplorerApiErrors.ALREADY_VERIFIED_ALT:
          return;
        case ExplorerApiErrors.PROXY_FAILED:
          errorMessage = `${errorMessageBase} Proxy verification failed, try manually?`;
          break;
        case ExplorerApiErrors.BYTECODE_MISMATCH:
          errorMessage = `${errorMessageBase} Compiled bytecode does not match deployed bytecode, check constructor arguments?`;
          break;
        default:
          errorMessage = `${errorMessageBase} Verification failed. ${
            result.result ?? response.statusText
          }`;
          break;
      }

      if (errorMessage) {
        this.logger(errorMessage);
        throw new Error(errorMessage);
      }
    }

    return result.result;
  }

  private async isAlreadyVerified(
    chain: ChainName,
    input: ContractVerificationInput,
  ) {
    try {
      const result = await this.submitForm(
        chain,
        ExplorerApiActions.GETSOURCECODE,
        {
          ...this.compilerOptions,
          address: input.address,
        },
      );
      return !!result[0]?.SourceCode;
    } catch (error) {
      this.logger(
        `[${chain}] [${input.name}] Error checking if contract is already verified: ${error}`,
      );
      return false;
    }
  }

  async verifyProxy(
    chain: ChainName,
    input: ContractVerificationInput,
  ): Promise<void> {
    if (input.isProxy) {
      try {
        const proxyGuid = await this.submitForm(
          chain,
          ExplorerApiActions.MARK_PROXY,
          {
            address: input.address,
          },
        );

        const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
          chain,
          input.address,
        );

        // poll for verified proxy status
        if (proxyGuid) {
          await this.submitForm(chain, ExplorerApiActions.CHECK_PROXY_STATUS, {
            guid: proxyGuid,
          });
          this.logger(
            `[${chain}] [${input.name}] Successfully verified proxy ${addressUrl}#readProxyContract`,
          );
        }
      } catch (error) {
        console.error(
          `[${chain}] [${input.name}] Verification of proxy at ${input.address} failed`,
        );
        throw error;
      }
    }
  }

  async verifyImplementation(
    chain: ChainName,
    input: ContractVerificationInput,
  ): Promise<void> {
    this.logger(
      `[${chain}] [${input.name}] Verifying implementation at ${input.address}`,
    );

    const data = {
      sourceCode: this.flattenedSource,
      contractname: input.name,
      contractaddress: input.address,
      // TYPO IS ENFORCED BY API
      constructorArguements: strip0x(input.constructorArguments ?? ''),
      ...this.compilerOptions,
    };

    const guid = await this.submitForm(
      chain,
      ExplorerApiActions.VERIFY_IMPLEMENTATION,
      data,
    );

    const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
      chain,
      input.address,
    );

    // poll for verified status
    if (guid) {
      try {
        await this.submitForm(chain, ExplorerApiActions.CHECK_STATUS, { guid });
        this.logger(
          `[${chain}] [${input.name}] Successfully verified ${addressUrl}#code`,
        );
      } catch (error) {
        console.error(
          `[${chain}] [${input.name}] Verifying implementation at ${input.address} failed`,
        );
        throw error;
      }
    }
  }

  async verifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
  ): Promise<void> {
    if (input.address === ethers.constants.AddressZero) {
      return;
    }

    if (Array.isArray(input.constructorArguments)) {
      this.logger(
        `[${chain}] [${input.name}] Constructor arguments in legacy format, skipping`,
      );
      return;
    }

    if (await this.isAlreadyVerified(chain, input)) {
      const addressUrl = await this.multiProvider.tryGetExplorerAddressUrl(
        chain,
        input.address,
      );
      this.logger(
        `[${chain}] [${input.name}] Contract already verified at ${addressUrl}#code`,
      );
      // There is a rate limit of 5 requests per second
      await sleep(200);
      return;
    } else {
      await this.verifyImplementation(chain, input);
    }
    await this.verifyProxy(chain, input);
  }
}
