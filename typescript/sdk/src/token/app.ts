import { HypERC20__factory } from '@hyperlane-xyz/core';

import { appFromAddressesMapHelper } from '../contracts/contracts';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../contracts/types';
import { MultiProvider } from '../providers/MultiProvider';
import { Router, RouterApp } from '../router/RouterApps';

import { TokenFactories } from './contracts';

export class TokenApp extends RouterApp<TokenFactories> {
  router(contracts: HyperlaneContracts<TokenFactories>): Router {
    return contracts.router;
  }

  static fromAddresses(
    addresses: HyperlaneAddressesMap<any>,
    mp: MultiProvider,
  ): TokenApp {
    // TODO: make factories generic?
    const { contractsMap, multiProvider } =
      appFromAddressesMapHelper<TokenFactories>(
        addresses,
        {
          router: new HypERC20__factory(),
        },
        mp,
      );
    return new TokenApp(contractsMap, multiProvider);
  }
}
