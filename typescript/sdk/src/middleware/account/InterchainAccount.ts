import { InterchainAccountRouter } from '@hyperlane-xyz/core';

import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddresses } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';
import { ChainMap, ChainName } from '../../types';

import {
  InterchainAccountContracts,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountContractsMap =
  ChainMap<InterchainAccountContracts>;

export class InterchainAccount extends RouterApp<InterchainAccountContracts> {
  constructor(
    contractsMap: InterchainAccountContractsMap,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  router(contracts: InterchainAccountContracts): InterchainAccountRouter {
    return contracts.interchainAccountRouter.contract;
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses>,
    multiProvider: MultiProvider,
  ): InterchainAccount {
    const { contracts, intersectionProvider } =
      this.buildContracts<InterchainAccountContracts>(
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

  getContracts(chain: ChainName): InterchainAccountContracts {
    return super.getContracts(chain);
  }
}
