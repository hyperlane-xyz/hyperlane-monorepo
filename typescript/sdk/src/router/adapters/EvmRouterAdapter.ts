/* eslint-disable @typescript-eslint/no-unused-vars */
import {
  GasRouter,
  GasRouter__factory,
  Router,
  Router__factory,
} from '@hyperlane-xyz/core';
import { types, utils } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';

import { IGasRouterAdapter, IRouterAdapter } from './types';

// Interacts with native currencies
export class EvmRouterAdapter implements IRouterAdapter {
  constructor(
    public readonly multiProvider: MultiProtocolProvider<{
      router: types.Address;
    }>,
  ) {}

  interchainSecurityModule(chain: ChainName): Promise<types.Address> {
    return this.getConnectedContract(chain).interchainSecurityModule();
  }

  owner(chain: ChainName): Promise<types.Address> {
    return this.getConnectedContract(chain).owner();
  }

  remoteDomains(originChain: ChainName): Promise<types.Domain[]> {
    return this.getConnectedContract(originChain).domains();
  }

  async remoteRouter(
    originChain: ChainName,
    remoteDomain: types.Domain,
  ): Promise<types.Address> {
    const routerAddressesAsBytes32 = await this.getConnectedContract(
      originChain,
    ).routers(remoteDomain);
    return utils.bytes32ToAddress(routerAddressesAsBytes32);
  }

  async remoteRouters(
    originChain: ChainName,
  ): Promise<Array<{ domain: types.Domain; address: types.Address }>> {
    const domains = await this.remoteDomains(originChain);
    const routers: types.Address[] = await Promise.all(
      domains.map((d) => this.remoteRouter(originChain, d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  protected getConnectedContract(chain: ChainName): Router {
    const address = this.multiProvider.getChainMetadata(chain).router;
    // TODO support alternative provider types here
    const provider = this.multiProvider.getEthersV5Provider(chain);
    return Router__factory.connect(address, provider);
  }
}

export class EvmGasRouterAdapter
  extends EvmRouterAdapter
  implements IGasRouterAdapter
{
  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<string> {
    const destDomain = this.multiProvider.getDomainId(destination);
    const amount = await this.getConnectedContract(origin).quoteGasPayment(
      destDomain,
    );
    return amount.toString();
  }

  protected override getConnectedContract(chain: ChainName): GasRouter {
    const address = this.multiProvider.getChainMetadata(chain).router;
    // TODO support alternative provider types here
    const provider = this.multiProvider.getEthersV5Provider(chain);
    return GasRouter__factory.connect(address, provider);
  }
}
