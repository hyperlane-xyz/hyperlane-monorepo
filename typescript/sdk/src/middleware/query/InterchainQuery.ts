import { InterchainQueryRouter } from '@hyperlane-xyz/core';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddresses, HyperlaneContracts } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';
import { ChainMap } from '../../types';

import { interchainQueryFactories } from './contracts';

export class InterchainQuery extends RouterApp<
  typeof interchainQueryFactories
> {
  router(
    contracts: HyperlaneContracts<typeof interchainQueryFactories>,
  ): InterchainQueryRouter {
    return contracts.interchainQueryRouter;
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses<typeof interchainQueryFactories>>,
    multiProvider: MultiProvider,
  ): InterchainQuery {
    const { contracts, intersectionProvider } = this.buildContracts(
      addresses,
      interchainQueryFactories,
      multiProvider,
    );
    return new InterchainQuery(contracts, intersectionProvider);
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): InterchainQuery {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return InterchainQuery.fromAddresses(envAddresses, multiProvider);
  }
}
