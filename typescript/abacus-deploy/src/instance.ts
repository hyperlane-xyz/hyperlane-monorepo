import { ethers } from 'ethers';
import { ChainConfig } from './types';
import { Contracts } from './contracts';

export abstract class Instance<T extends Contracts> {
  constructor(
    public readonly chain: ChainConfig,
    public readonly contracts: T,
  ) {
  }

  abstract static async deploy(chain: ChainConfig, domains: types.Domain[], config: any): Promise<Instance<T>>;

  get signer(): ethers.Signer {
    return this.chain.signer;
  }

  get provider(): ethers.providers.JsonRpcProvider {
    return this.chain.provider;
  }

  async ready(): Promise<ethers.providers.Network> {
    return await this.provider.ready;
  }
}

export class ContractDeployer {
  constructor(
    public readonly chain: ChainConfig,
    public readonly wait = true;
  ) {}

  async deploy(factory: typeof ethers.ContractFactory, ...args: any[]): Promise<ethers.Contract> {
    const _factory = new factory(this.chain.signer)
    const contract = await _factory.deploy(...args, this.chain.overrides);
    if (this.wait) {
      await contract.deployTransaction.wait(this.chain.confirmations);
    }
    return contract
  }

