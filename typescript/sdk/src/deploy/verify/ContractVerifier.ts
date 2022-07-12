import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'hardhat';

import { sleep } from '@abacus-network/utils/dist/src/utils';

import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { MultiGeneric } from '../../utils';

import {
  CompilerOptions,
  ContractVerificationInput,
  VerificationInput,
} from './types';

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
    protected readonly compilerOptions: CompilerOptions,
  ) {
    super(verificationInputs);
    this.logger = debug('abacus:ContractVerifier');
  }

  verify() {
    return Promise.allSettled(
      this.chains().map((chain) => this.verifyChain(chain, this.get(chain))),
    );
  }

  async verifyChain(chain: Chain, inputs: VerificationInput) {
    this.logger(`Verifying ${chain}...`);
    for (const input of inputs) {
      await this.verifyContract(chain, input);
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

    // avoid rate limiting (5 requests per second)
    await sleep(1000 / 5);

    const result = JSON.parse(await response.text());
    if (result.message === 'NOTOK') {
      if (result.result === 'Contract source code already verified') {
        return;
      } else if (result.result === 'Pending in queue') {
        await sleep(5000);
        return this.submitForm(chain, action, options);
      }
      console.error(chain, result.result);
      throw new Error(`Verification failed: ${result.result}`);
    }

    return result.result;
  }

  async verifyContract(chain: Chain, input: ContractVerificationInput) {
    if (input.address === ethers.constants.AddressZero) {
      return;
    }

    this.logger.extend(chain)(`Checking ${input.address} (${input.name})...`);

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

    const addressUrl = await this.multiProvider
      .getChainConnection(chain)
      .getAddressUrl(input.address);

    // poll for verified status
    if (guid) {
      await this.submitForm(chain, ExplorerApiActions.CHECK_STATUS, { guid });
    }
    this.logger.extend(chain)(`Implementation verified at ${addressUrl}#code`);

    // poll for verified proxy status (if applicable)
    // if (input.isProxy) {
    //   TODO: investigate why this is not working
    //   const proxyGuid = await this.submitForm(chain, ExplorerApiActions.MARK_PROXY, {
    //     address: input.address,
    //   });
    //   await this.submitForm(chain, ExplorerApiActions.CHECK_PROXY_STATUS, {guid: proxyGuid});
    // }
    // this.logger.extend(chain)(`Proxy verified at ${addressUrl}#readProxyContract`);
  }
}
