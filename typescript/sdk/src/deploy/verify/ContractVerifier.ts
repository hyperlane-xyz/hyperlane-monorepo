import fetch from 'cross-fetch';
import { Debugger, debug } from 'debug';
import { ethers } from 'hardhat';

import { sleep } from '@abacus-network/utils/dist/src/utils';

import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';
import { MultiGeneric } from '../../utils';

import { ContractVerificationInput, VerificationInput } from './types';

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
    return Promise.allSettled(
      this.chains().map((chain) => this.verifyChain(chain, this.get(chain))),
    );
  }

  async verifyChain(chain: Chain, inputs: VerificationInput) {
    this.logger(`Verifying ${chain}...`);
    for (const input of inputs) {
      await this.verifyContract(chain, input);
      sleep(1000); // avoid rate limiting
    }
  }

  // from https://docs.etherscan.io/api-endpoints/contracts#source-code-submission-gist
  buildFormData(chain: Chain, input: ContractVerificationInput) {
    return {
      module: 'contract',
      action: input.isProxy ? 'verifyproxycontract' : 'verifysourcecode',
      codeformat: 'solidity-single-file',
      // TODO: make compiler options configurable
      compilerversion: 'v0.8.13+commit.abaa5c0e',
      licenseType: 3,
      optimizationUsed: 1,
      runs: 999999,
      apikey: this.apiKeys[chain],
      sourceCode: this.flattenedSource,
      contractname: input.name,
      contractaddress: input.address,
      constructorArguements: input.constructorArguments,
    };
  }

  async verifyContract(chain: Chain, input: ContractVerificationInput) {
    if (input.address === ethers.constants.AddressZero) {
      return;
    }

    const chainConnection = this.multiProvider.getChainConnection(chain);
    this.logger(
      `Contract ${input.name} at ${await chainConnection.getAddressUrl(
        input.address,
      )}`,
    );

    const data = this.buildFormData(chain, input);
    const apiUrl = chainConnection.getApiUrl();

    try {
      await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });
    } catch (e) {
      console.error(e);
    }
  }
}
