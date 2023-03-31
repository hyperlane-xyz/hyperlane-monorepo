import { InterchainAccountRouter } from '@hyperlane-xyz/core';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddressesMap, HyperlaneContracts } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts';

export class InterchainAccount extends RouterApp<InterchainAccountFactories> {
  router(
    contracts: HyperlaneContracts<InterchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
  }

  static fromAddresses(
    addresses: HyperlaneAddressesMap<any>,
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
