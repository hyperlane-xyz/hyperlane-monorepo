import type { BigNumber, ethers } from 'ethers';

import { GasRouter, ProxyAdmin, Router } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from './HyperlaneApp';
import { HyperlaneContracts, HyperlaneFactories } from './contracts';
import { ProxiedContract, TransparentProxyAddresses } from './proxy';
import { ChainMap, ChainName } from './types';
import { objMap, promiseObjAll } from './utils/objects';

export type RouterContracts<RouterContract extends Router = Router> =
  HyperlaneContracts & {
    router: RouterContract;
  };

export type ProxiedRouterContracts<RouterContract extends Router = Router> =
  RouterContracts<RouterContract> & {
    proxyAdmin: ProxyAdmin;
    proxiedRouter: ProxiedContract<RouterContract, TransparentProxyAddresses>;
  };

type RouterFactory<RouterContract extends Router = Router> =
  ethers.ContractFactory & {
    deploy: (...args: any[]) => Promise<RouterContract>;
  };

export type RouterFactories<RouterContract extends Router = Router> =
  HyperlaneFactories & {
    router: RouterFactory<RouterContract>;
  };

export type ConnectionClientConfig = {
  mailbox: types.Address;
  interchainGasPaymaster: types.Address;
  interchainSecurityModule?: types.Address;
};

export { Router } from '@hyperlane-xyz/core';

export class RouterApp<
  Contracts extends RouterContracts,
> extends HyperlaneApp<Contracts> {
  getSecurityModules = (): Promise<ChainMap<types.Address>> =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) =>
        contracts.router.interchainSecurityModule(),
      ),
    );

  getOwners = (): Promise<ChainMap<types.Address>> =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) => contracts.router.owner()),
    );
}

export class GasRouterApp<
  Contracts extends RouterContracts<GasRouter>,
> extends RouterApp<Contracts> {
  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<BigNumber> {
    return this.getContracts(origin).router.quoteGasPayment(
      this.multiProvider.getDomainId(destination),
    );
  }
}
