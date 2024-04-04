import { TokenRouter } from '@hyperlane-xyz/core';
import { objKeys } from '@hyperlane-xyz/utils';

import { appFromAddressesMapHelper } from '../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
} from '../contracts/types.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { GasRouterApp } from '../router/RouterApps.js';

import {
  HypERC20Factories,
  hypERC20Tokenfactories,
  hypERC20factories,
} from './contracts.js';

export class HypERC20App extends GasRouterApp<HypERC20Factories, TokenRouter> {
  constructor(
    contractsMap: HyperlaneContractsMap<HypERC20Factories>,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(contracts: HyperlaneContracts<HypERC20Factories>): TokenRouter {
    for (const key of objKeys(hypERC20Tokenfactories)) {
      if (contracts[key]) {
        return contracts[key] as unknown as TokenRouter;
      }
    }
    throw new Error('No router found in contracts');
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<HypERC20Factories>,
    multiProvider: MultiProvider,
  ): HypERC20App {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      hypERC20factories,
      multiProvider,
    );
    return new HypERC20App(helper.contractsMap, helper.multiProvider);
  }
}
