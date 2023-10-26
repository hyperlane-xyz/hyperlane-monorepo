import { Address, Domain } from '@hyperlane-xyz/utils';

import { BaseCwAdapter } from '../../app/MultiProtocolApp';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider';
import { ChainName } from '../../types';

import { IGasRouterAdapter, IRouterAdapter } from './types';

// TODO: import from ts bindings
type IsmResponse = {
  ism: Address;
};

type OwnerResponse = {
  owner: Address;
};

type DomainsResponse = {
  domains: number[];
};

type DomainRouteSet = {
  domain: number;
  route: string;
};

type RouteResponse = {
  route: DomainRouteSet;
};

type RoutesResponse = {
  routes: DomainRouteSet[];
};

export class CwRouterAdapter extends BaseCwAdapter implements IRouterAdapter {
  public readonly contractAddress: Address;

  constructor(
    public readonly chainName: ChainName,
    public readonly multiProvider: MultiProtocolProvider<any>,
    public readonly addresses: { router: Address },
  ) {
    super(chainName, multiProvider, addresses);
    this.contractAddress = addresses.router;
  }

  async interchainSecurityModule(): Promise<Address> {
    const ismResponse: IsmResponse =
      await this.getProvider().queryContractSmart(this.contractAddress, {
        get_ism: {},
      });
    return ismResponse.ism;
  }

  async owner(): Promise<Address> {
    const ownerResponse: OwnerResponse =
      await this.getProvider().queryContractSmart(this.contractAddress, {
        owner: {},
      });
    return ownerResponse.owner;
  }

  async remoteDomains(): Promise<Domain[]> {
    const domainsResponse: DomainsResponse =
      await this.getProvider().queryContractSmart(this.contractAddress, {
        domains: {},
      });
    return domainsResponse.domains;
  }

  async remoteRouter(remoteDomain: Domain): Promise<Address> {
    const routeResponse: RouteResponse =
      await this.getProvider().queryContractSmart(this.contractAddress, {
        get_route: {
          domain: remoteDomain,
        },
      });
    return routeResponse.route.route;
  }

  async remoteRouters(): Promise<Array<{ domain: Domain; address: Address }>> {
    const routesResponse: RoutesResponse =
      await this.getProvider().queryContractSmart(this.contractAddress, {
        list_routes: {},
      });
    return routesResponse.routes.map((r) => ({
      domain: r.domain,
      address: r.route,
    }));
  }
}

export class CwGasRouterAdapter
  extends CwRouterAdapter
  implements IGasRouterAdapter
{
  async quoteGasPayment(_: ChainName): Promise<string> {
    throw new Error('Method not implemented.');
  }
}
