import { ChainConfig } from './types';
import { ethers } from 'ethers';

// TODO(asa): Can T extend Contracts?
export abstract class Instance <T> {
  constructor(
    public readonly chain: ChainConfig,
    public readonly contracts: T,
  ) {
  }

  // this is currently a kludge to account for ethers issues
  get overrides(): ethers.Overrides {
    let overrides: ethers.Overrides = {};
    if (this.chain.overrides === undefined) {
      return overrides;
    }

    if (this.chain.supports1559) {
      overrides = {
        maxFeePerGas: this.chain.overrides.maxFeePerGas,
        maxPriorityFeePerGas: this.chain.overrides.maxPriorityFeePerGas,
        gasLimit: this.chain.overrides.gasLimit,
      };
    } else {
      overrides = {
        type: 0,
        gasPrice: this.chain.overrides.gasPrice,
        gasLimit: this.chain.overrides.gasLimit,
      };
    }

    return overrides;
  }

}
