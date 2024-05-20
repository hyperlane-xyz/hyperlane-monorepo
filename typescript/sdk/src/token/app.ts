import { TokenRouter } from '@hyperlane-xyz/core';
import { objKeys } from '@hyperlane-xyz/utils';

import {
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterApp } from '../router/RouterApps.js';

import { HypERC20Factories, hypERC20factories } from './contracts.js';

export class HypERC20App extends GasRouterApp<HypERC20Factories, TokenRouter> {
  constructor(
    contractsMap: HyperlaneContractsMap<HypERC20Factories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): TokenRouter {
    for (const key of objKeys(hypERC20factories)) {
      if (contracts[key]) {
        return contracts[key] as unknown as TokenRouter;
      }
    }
    throw new Error('No router found in contracts');
  }
}
