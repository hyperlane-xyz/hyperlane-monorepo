import { ethers } from 'ethers';
import { ChainConfig } from './types';

export class ContractDeployer {
  constructor(
    public readonly chain: ChainConfig,
    public readonly wait = true,
  ) {}

  async deploy<T extends ethers.Contract>(
    factory: ethers.ContractFactory,
    ...args: any[]
  ): Promise<T> {
    const contract = (await factory.deploy(...args, this.chain.overrides)) as T;
    if (this.wait) {
      await contract.deployTransaction.wait(this.chain.confirmations);
    }
    return contract;
  }
}
