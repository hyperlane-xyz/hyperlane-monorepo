import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'hardhat';

import { sleep } from '@abacus-network/utils/dist/src/utils';

import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { MultiGeneric } from '../../utils';

import { ContractVerificationInput, VerificationInput } from './types';

enum ExplorerApiActions {
  VERIFY_IMPLEMENTATION = 'verifysourcecode',
  MARK_PROXY = 'verifyproxycontract',
  CHECK_STATUS = 'checkverifystatus',
  CHECK_PROXY_STATUS = 'checkproxyverification',
}

const strip0x = (hexstr: string) =>
  hexstr.startsWith('0x') ? hexstr.slice(2) : hexstr;

export class ContractVerifier<Chain extends ChainName> extends MultiGeneric<
  Chain,
  VerificationInput
> {
  protected logger: Debugger;

  constructor(
    verificationInputs: ChainMap<Chain, VerificationInput>,
    protected readonly multiProvider: MultiProvider<Chain>,
    protected readonly apiKeys: ChainMap<Chain, string>,
    protected readonly flattenedSource: string,
  ) {
    super(verificationInputs);
    this.logger = debug('abacus:ContractVerifier');
  }

  verify() {
    return Promise.allSettled(
      this.chains().map((chain) =>
        this.verifyChain(chain, this.get(chain), this.logger.extend(chain)),
      ),
    );
  }

  async verifyChain(
    chain: Chain,
    inputs: VerificationInput,
    logger = this.logger,
  ) {
    logger(`Verifying ${chain}...`);
    for (const input of inputs) {
      await this.verifyContract(chain, input, logger);
    }
  }

  private async submitForm(
    chain: Chain,
    action: ExplorerApiActions,
    options?: Record<string, string>,
  ): Promise<any> {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const apiUrl = chainConnection.getApiUrl();

    const params = new URLSearchParams({
      apikey: this.apiKeys[chain],
      module: 'contract',
      action,
      ...options,
    });

    let response: Response;
    if (
      action === ExplorerApiActions.CHECK_STATUS ||
      action === ExplorerApiActions.CHECK_PROXY_STATUS
    ) {
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

    // avoid rate limiting
    await sleep(1000);

    const result = JSON.parse(await response.text());
    if (result.message === 'NOTOK') {
      if (result.result === 'Contract source code already verified') {
        return;
      } else if (result.result === 'Pending in queue') {
        await sleep(50000);
        return this.submitForm(chain, action, options);
      }
      throw new Error(`Verification failed: ${result.result}`);
    }

    return result.result;
  }

  async verifyContract(
    chain: Chain,
    input: ContractVerificationInput,
    logger = this.logger,
  ) {
    if (input.address === ethers.constants.AddressZero) {
      return;
    }

    logger(`Checking ${input.address} (${input.name})...`);

    const data = {
      sourceCode: this.flattenedSource,
      contractname: input.name,
      contractaddress: input.address,
      // TYPO IS ENFORCED BY API
      constructorArguements: strip0x(input.constructorArguments ?? ''),
      codeformat: 'solidity-single-file',
      // TODO: make compiler options configurable
      compilerversion: 'v0.8.13+commit.abaa5c0e',
      licenseType: '3',
      optimizationUsed: '1',
      runs: '999999',
    };

    const guid = await this.submitForm(
      chain,
      ExplorerApiActions.VERIFY_IMPLEMENTATION,
      data,
    );

    const addressUrl = await this.multiProvider
      .getChainConnection(chain)
      .getAddressUrl(input.address);

    // poll for verified status
    if (guid) {
      await this.submitForm(chain, ExplorerApiActions.CHECK_STATUS, { guid });
      logger(`Implementation verified at ${addressUrl}#code`);
    }

    // poll for verified proxy status (if applicable)
    // if (input.isProxy) {
    //   TODO: investigate why this is not working
    //   const proxyGuid = await this.submitForm(chain, ExplorerApiActions.MARK_PROXY, {
    //     address: input.address,
    //   });
    //   await this.submitForm(chain, ExplorerApiActions.CHECK_PROXY_STATUS, {guid: proxyGuid});
    //   logger(`Proxy verified at ${addressUrl}#readProxyContract`);
    // }
  }
}
