import { ethers } from 'ethers';
import { Instance } from './instance';
import { ChainConfig } from './types';

export abstract class Deploy<T extends Instance> {

  constructor(public readonly instances: Record<number, T>) {}

  static async deploy(chains: Record<number, ChainConfig>, config: any): Promise<Deploy<T>> {
    const domains = Object.keys(chains).map((d) => parseInt(d))
    const instances = Record<number, T>;
    for (const domain in domains) {
      instances[domain] = await T.deploy(chains[domain], domains, config)
    }
    const deploy = new Deploy(instances);
    return deploy
  }

  get domains(): types.Domain[] {
    return Object.keys(instances).map((d) => parseInt(d))
  }

  get signer(domain: types.Domain): ethers.Signer {
    return this.instances[domain].signer;
  }
}
