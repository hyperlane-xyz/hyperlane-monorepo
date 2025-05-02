import {
  GasRouter,
  GasRouter__factory,
  Router,
  Router__factory,
} from '@hyperlane-xyz/core';
import { Address, Domain, bytes32ToAddress } from '@hyperlane-xyz/utils';

import { BaseEvmAdapter } from '../../app/MultiProtocolApp.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ChainName } from '../../types.js';

import { IGasRouterAdapter, IRouterAdapter } from './types.js';

export class EvmRouterAdapter extends BaseEvmAdapter implements IRouterAdapter {
  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { router: Address },
  ) {
    super(chainName, multiProvider, addresses);
  }

  interchainSecurityModule(): Promise<Address> {
    return this.getConnectedContract().interchainSecurityModule();
  }

  owner(): Promise<Address> {
    return this.getConnectedContract().owner();
  }

  remoteDomains(): Promise<Domain[]> {
    return this.getConnectedContract().domains();
  }

  async remoteRouter(remoteDomain: Domain): Promise<Address> {
    const routerAddressesAsBytes32 =
      await this.getConnectedContract().routers(remoteDomain);
    return bytes32ToAddress(routerAddressesAsBytes32);
  }

  async remoteRouters(): Promise<Array<{ domain: Domain; address: Address }>> {
    const domains = await this.remoteDomains();
    const routers: Address[] = await Promise.all(
      domains.map((d) => this.remoteRouter(d)),
    );
    return domains.map((d, i) => ({ domain: d, address: routers[i] }));
  }

  getConnectedContract(): Router {
    return Router__factory.connect(this.addresses.router, this.getProvider());
  }
}

export class EvmGasRouterAdapter
  extends EvmRouterAdapter
  implements IGasRouterAdapter
{
  async quoteGasPayment(destination: ChainName): Promise<string> {
    const destDomain = this.multiProvider.getDomainId(destination);
    const amount =
      await this.getConnectedContract().quoteGasPayment(destDomain);
    return amount.toString();
  }

  override getConnectedContract(): GasRouter {
    return GasRouter__factory.connect(
      this.addresses.router,
      this.getProvider(),
    );
  }
}
