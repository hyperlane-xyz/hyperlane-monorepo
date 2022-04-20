import { ethers } from 'ethers';
import { AbacusRouterAddresses, AbacusRouterContracts } from './contracts';
import { MultiProvider } from './provider';
import { ChainName } from './types';

export class AbacusApp<
  Networks extends ChainName,
  Addresses extends AbacusRouterAddresses,
  Contracts extends AbacusRouterContracts<Addresses>,
> extends MultiProvider<Networks, { contracts: Contracts }> {
  getContracts(network: Networks) {
    return this.get(network).contracts;
  }

  registerProvider(network: Networks, provider: ethers.providers.Provider) {
    this.get(network).provider.registerProvider(provider);
    this.getContracts(network).reconnect(provider);
  }

  registerSigner(network: Networks, signer: ethers.Signer) {
    this.get(network).provider.registerSigner(signer);
    this.getContracts(network).reconnect(signer);
  }
}
