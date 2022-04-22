import { ethers } from 'ethers';
import { IAbacusContracts } from './contracts';
import { domains } from './domains';
import { ChainName } from './types';
import { MultiGeneric } from './utils';

// TODO: add generic fromEnvironment

export class AbacusApp<
  Contracts extends IAbacusContracts<any>,
  Networks extends ChainName = ChainName,
> extends MultiGeneric<Contracts, Networks> {
  getContracts(network: Networks) {
    return this.get(network).contracts;
  }

  async registerProvider(
    network: Networks,
    provider: ethers.providers.Provider,
  ) {
    const actualNetwork = await provider.getNetwork();
    if (actualNetwork.chainId !== domains[network].id) {
      throw new Error(
        `Provider network ${actualNetwork} does not match ${network}`,
      );
    }
    this.get(network).reconnect(provider);
  }

  registerSigner(network: Networks, signer: ethers.Signer) {
    this.get(network).reconnect(signer);
  }
}
