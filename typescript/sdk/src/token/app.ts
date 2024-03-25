import { TokenRouter } from '@hyperlane-xyz/core';

import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { GasRouterApp } from '../router/RouterApps';

import { HypERC20Factories, hypERC20factories } from './contracts';

export class HypERC20App extends GasRouterApp<HypERC20Factories, TokenRouter> {
  router(contracts: HyperlaneContracts<HypERC20Factories>): TokenRouter {
    return Object.values(contracts)[0] as any;
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<HypERC20Factories>,
    multiprovider: MultiProvider,
  ): HypERC20App {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      hypERC20factories,
      multiprovider,
    );
    return new HypERC20App(helper.contractsMap, helper.multiProvider);
  }
}
