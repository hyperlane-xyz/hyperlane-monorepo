import { ethers } from 'ethers';
import { AbacusContracts } from './contracts';
import { ChainName } from './types';
import { MultiGeneric } from './utils';

export class AbacusApp<
  N extends ChainName,
  C extends AbacusContracts<any, any>,
> extends MultiGeneric<N, C> {
  getContracts(network: N) {
    return this.get(network).contracts;
  }

  registerProvider(network: N, provider: ethers.providers.Provider) {
    this.get(network).reconnect(provider);
  }

  registerSigner(network: N, signer: ethers.Signer) {
    this.get(network).reconnect(signer);
  }
}
