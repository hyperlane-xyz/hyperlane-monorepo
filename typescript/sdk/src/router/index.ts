import type { BigNumber } from 'ethers';

import { GasRouter } from '@hyperlane-xyz/core';
import type { types } from '@hyperlane-xyz/utils';

import { HyperlaneApp } from '../HyperlaneApp';
import { ChainMap, ChainName } from '../types';
import { objMap, promiseObjAll } from '../utils/objects';

import { RouterContracts } from './types';

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

export { GasRouterDeployer } from './GasRouterDeployer';
export { HyperlaneRouterChecker } from './HyperlaneRouterChecker';
export { HyperlaneRouterDeployer } from './HyperlaneRouterDeployer';
export {
  ProxiedRouterContracts,
  RouterContracts,
  RouterFactories,
  ConnectionClientConfig,
  GasRouterConfig,
  RouterConfig,
} from './types';
