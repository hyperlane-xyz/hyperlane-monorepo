import axios from 'axios';

import { ChainName } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

import { ContractVerificationInput, VerificationInput } from './types';

const etherscanChains = [
  'ethereum',
  'kovan',
  'goerli',
  'ropsten',
  'rinkeby',
  'polygon',
];

export abstract class ContractVerifier {
  constructor(public readonly key: string) {}

  abstract chainNames: ChainName[];
  abstract getVerificationInput(chain: ChainName): VerificationInput;

  static etherscanLink(chain: ChainName, address: types.Address) {
    if (chain === 'polygon') {
      return `https://polygonscan.com/address/${address}`;
    }

    const prefix = chain === 'ethereum' ? '' : `${chain}.`;
    return `https://${prefix}etherscan.io/address/${address}`;
  }

  async verify(hre: any) {
    let chain = hre.network.name;

    if (chain === 'mainnet') {
      chain = 'ethereum';
    }

    const envError = (network: string) =>
      `pass --network tag to hardhat task (current network=${network})`;

    // assert that network from .env is supported by Etherscan
    if (!etherscanChains.includes(chain)) {
      throw new Error(`Network not supported by Etherscan; ${envError(chain)}`);
    }

    // get the JSON verification inputs for the given network
    // from the latest contract deploy; throw if not found
    const verificationInputs = this.getVerificationInput(chain);

    // loop through each verification input for each contract in the file
    for (const verificationInput of verificationInputs) {
      // attempt to verify contract on etherscan
      // (await one-by-one so that Etherscan doesn't rate limit)
      await this.verifyContract(chain, verificationInput, hre);
    }
  }

  async verifyContract(
    chain: ChainName,
    input: ContractVerificationInput,
    hre: any,
  ) {
    try {
      console.log(
        `   Attempt to verify ${
          input.name
        }   -  ${ContractVerifier.etherscanLink(chain, input.address)}`,
      );
      await hre.run('verify:verify', {
        chain,
        address: input.address,
        constructorArguments: input.constructorArguments,
      });
      console.log(`   SUCCESS verifying ${input.name}`);

      if (input.isProxy) {
        console.log(`   Attempt to verify as proxy`);
        await this.verifyProxy(chain, input.address);
        console.log(`   SUCCESS submitting proxy verification`);
      }
    } catch (e) {
      console.log(`   ERROR verifying ${input.name}`);
      console.error(e);
    }
    console.log('\n\n'); // add space after each attempt
  }

  async verifyProxy(chain: ChainName, address: types.Address) {
    const suffix = chain === 'ethereum' ? '' : `-${chain}`;

    console.log(`   Submit ${address} for proxy verification on ${chain}`);
    // Submit contract for verification
    const verifyResponse = await axios.post(
      `https://api${suffix}.etherscan.io/api`,
      `address=${address}`,
      {
        params: {
          module: 'contract',
          action: 'verifyproxycontract',
          apikey: this.key,
        },
      },
    );

    // Validate that submission worked
    if (verifyResponse.status !== 200) {
      throw new Error('Verify POST failed');
    } else if (verifyResponse.data.status != '1') {
      throw new Error(verifyResponse.data.result);
    }

    console.log(`   Submitted.`);
  }
}
