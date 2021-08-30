import { ethers } from 'ethers';
import { Chain } from './chain';
import { Contracts } from './contracts';

export type ContractVerificationInput = {
  name: string;
  address: string;
  constructorArguments: any[];
  isProxy?: boolean;
};

export abstract class Deploy<T extends Contracts> {
  readonly chain: Chain;
  readonly test: boolean;
  contracts: T;
  verificationInput: ContractVerificationInput[];

  abstract get ubcAddress(): string | undefined;

  constructor(chain: Chain, contracts: T, test: boolean = false) {
    this.chain = chain;
    this.verificationInput = [];
    this.test = test;
    this.contracts = contracts;
  }

  get deployer(): ethers.Signer {
    return this.chain.deployer;
  }

  get provider(): ethers.providers.Provider {
    return this.chain.provider;
  }

  get supports1559(): boolean {
    let notSupported = ['kovan', 'alfajores', 'baklava', 'celo'];
    return notSupported.indexOf(this.chain.name) === -1;
  }

  // this is currently a kludge to account for ethers issues
  get overrides(): ethers.Overrides {
    let overrides: ethers.Overrides = {
      type: this.supports1559 ? 2 : 0,
    };

    if (this.supports1559) {
      overrides.gasPrice = this.chain.gasPrice;
      overrides.gasLimit = 6_000_000;
    }

    return overrides;
  }
}
