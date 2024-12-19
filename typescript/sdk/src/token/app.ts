import { Logger } from 'pino';

import { TokenRouter } from '@hyperlane-xyz/core';
import { Address, objKeys } from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterApp } from '../router/RouterApps.js';
import { ProxiedFactories, proxiedFactories } from '../router/types.js';
import { ChainMap } from '../types.js';

import { HypERC20Factories, hypERC20factories } from './contracts.js';

export class HypERC20App extends GasRouterApp<
  HypERC20Factories & ProxiedFactories,
  TokenRouter
> {
  constructor(
    contractsMap: HyperlaneContractsMap<HypERC20Factories & ProxiedFactories>,
    multiProvider: MultiProvider,
    logger?: Logger,
    foreignDeployments: ChainMap<Address> = {},
  ) {
    super(contractsMap, multiProvider, logger, foreignDeployments);
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): TokenRouter {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key] as unknown as TokenRouter;
      }
    }
    throw new Error('No router found in contracts');
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<HypERC20Factories & ProxiedFactories>,
    multiProvider: MultiProvider,
  ): HypERC20App {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      { ...hypERC20factories, ...proxiedFactories },
      multiProvider,
    );
    return new HypERC20App(helper.contractsMap, helper.multiProvider);
  }
}
