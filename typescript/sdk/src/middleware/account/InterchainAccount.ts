import { InterchainAccountRouter } from '@hyperlane-xyz/core';
import { ProtocolType } from '@hyperlane-xyz/utils';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments/index.js';
import {
  appFromAddressesMapHelper,
  filterChainMapToProtocol,
} from '../../contracts/contracts.js';
import {
  HyperlaneAddressesMap,
  HyperlaneContracts,
} from '../../contracts/types.js';
import { MultiProvider } from '../../providers/MultiProvider.js';
import { RouterApp } from '../../router/RouterApps.js';

import {
  InterchainAccountFactories,
  interchainAccountFactories,
} from './contracts.js';

export class InterchainAccount extends RouterApp<InterchainAccountFactories> {
  router(
    contracts: HyperlaneContracts<InterchainAccountFactories>,
  ): InterchainAccountRouter {
    return contracts.interchainAccountRouter;
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    // Filter out non-EVM chains, as interchain accounts are EVM only at the moment.
    const ethAddresses = filterChainMapToProtocol(
      envAddresses,
      ProtocolType.Ethereum,
      multiProvider,
    );
    return InterchainAccount.fromAddressesMap(ethAddresses, multiProvider);
  }

  static fromAddressesMap(
    addressesMap: HyperlaneAddressesMap<any>,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const helper = appFromAddressesMapHelper(
      addressesMap,
      interchainAccountFactories,
      multiProvider,
    );
    return new InterchainAccount(helper.contractsMap, helper.multiProvider);
  }
}
