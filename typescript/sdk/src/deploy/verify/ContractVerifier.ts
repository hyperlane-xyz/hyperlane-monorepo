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

  async verify() {
    for (const chain of this.chains().reverse()) {
      await this.verifyChain(chain, this.get(chain));
    }
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
  ) {
    const chainConnection = this.multiProvider.getChainConnection(chain);
    const apiUrl = chainConnection.getApiUrl();

    const params = new URLSearchParams({
      apikey: this.apiKeys[chain],
      module: 'contract',
      action,
      ...options,
    });

    let response: Response;
    if (action === ExplorerApiActions.CHECK_STATUS) {
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
      }
      throw new Error(`Verification ${action} failed: ${result.result}`);
    }

    return result.result;
  }

  async verifyContract(chain: Chain, input: ContractVerificationInput) {
    if (input.address === ethers.constants.AddressZero) {
      return;
    }

    const addressUrl = await this.multiProvider
      .getChainConnection(chain)
      .getAddressUrl(input.address);

    this.logger(`Checking ${input.name} implementation`);

    const guid = await this.submitForm(
      chain,
      ExplorerApiActions.VERIFY_IMPLEMENTATION,
      {
        sourceCode: this.flattenedSource,
        contractname: input.name,
        contractaddress: input.address,
        constructorArguments: input.constructorArguments ?? '',
        codeformat: 'solidity-single-file',
        // TODO: make compiler options configurable
        compilerversion: 'v0.8.13+commit.abaa5c0e',
        licenseType: '3',
        optimizationUsed: '1',
        runs: '999999',
      },
    );

    // exit if contract is pending implementation verification
    if (guid) {
      // this.logger(`Pending GUID ${guid}`);
      return;
    }

    this.logger(`Verified at ${addressUrl}#code`);

    // continue to marking as proxy if implementation is already verified
    if (input.isProxy) {
      this.logger(`Marking ${input.name} as proxy`);
      await this.submitForm(chain, ExplorerApiActions.MARK_PROXY, {
        address: input.address,
      });
    }
  }
}
