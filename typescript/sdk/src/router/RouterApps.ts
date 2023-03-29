import type { BigNumber } from 'ethers';

import { GasRouter, GasRouter__factory, Router } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { HyperlaneContracts } from '../contracts';
import { ChainMap, ChainName } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

export { Router } from '@hyperlane-xyz/core';

export abstract class RouterApp<
  Contracts extends HyperlaneContracts,
> extends HyperlaneApp<Contracts> {
  abstract router(contracts: Contracts): Router;

  getSecurityModules = (): Promise<ChainMap<types.Address>> =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) =>
        this.router(contracts).interchainSecurityModule(),
      ),
    );

  getOwners = (): Promise<ChainMap<types.Address>> =>
    promiseObjAll(
      objMap(this.contractsMap, (_, contracts) =>
        this.router(contracts).owner(),
      ),
    );
}

export type GasRouterContracts = {
  router: GasRouter;
};

export type GasRouterFactories = {
  router: GasRouter__factory;
};

export class GasRouterApp extends RouterApp<GasRouterContracts> {
  router(contracts: GasRouterContracts): GasRouter {
    return contracts.router;
  }

  async quoteGasPayment(
    origin: ChainName,
    destination: ChainName,
  ): Promise<BigNumber> {
    return this.getContracts(origin).router.quoteGasPayment(
      this.multiProvider.getDomainId(destination),
    );
  }
}
