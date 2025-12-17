import { type InterchainQueryRouter } from '@hyperlane-xyz/core';

import { appFromAddressesMapHelper } from '../../contracts/contracts.js';
import {
  type HyperlaneAddressesMap,
  type HyperlaneContracts,
} from '../../contracts/types.js';
import { type MultiProvider } from '../../providers/MultiProvider.js';
import { RouterApp } from '../../router/RouterApps.js';

import {
  type InterchainQueryFactories,
  interchainQueryFactories,
} from './contracts.js';

export class InterchainQuery extends RouterApp<InterchainQueryFactories> {
  router(
    contracts: HyperlaneContracts<InterchainQueryFactories>,
  ): InterchainQueryRouter {
    return contracts.interchainQueryRouter;
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): InterchainQuery {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      interchainQueryFactories,
      multiProvider,
    );
    return new InterchainQuery(helper.contractsMap, helper.multiProvider);
  }
}
