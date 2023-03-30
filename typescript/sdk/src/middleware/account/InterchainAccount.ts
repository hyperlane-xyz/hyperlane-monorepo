import { InterchainAccountRouter } from '@hyperlane-xyz/core';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddresses, HyperlaneContracts } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';
import { ChainMap } from '../../types';

import { interchainAccountFactories } from './contracts';

export class InterchainAccount extends RouterApp<
  typeof interchainAccountFactories
> {
  router(
    contracts: HyperlaneContracts<typeof interchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses<typeof interchainAccountFactories>>,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const { contracts, intersectionProvider } = this.buildContracts(
      addresses,
      interchainAccountFactories,
      multiProvider,
    );
    return new InterchainAccount(contracts, intersectionProvider);
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return InterchainAccount.fromAddresses(envAddresses, multiProvider);
  }
}
