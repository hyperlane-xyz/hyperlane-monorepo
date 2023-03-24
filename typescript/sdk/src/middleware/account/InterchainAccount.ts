import { HyperlaneApp } from '../../HyperlaneApp';
import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddresses } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { ChainMap, ChainName } from '../../types';

import {
  InterchainAccountContracts,
  interchainAccountFactories,
} from './contracts';

export type InterchainAccountContractsMap =
  ChainMap<InterchainAccountContracts>;

export class InterchainAccounts extends HyperlaneApp<InterchainAccountContracts> {
  constructor(
    contractsMap: InterchainAccountContractsMap,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses>,
    multiProvider: MultiProvider,
  ): InterchainAccounts {
    const { contracts, intersectionProvider } =
      this.buildContracts<InterchainAccountContracts>(
        addresses,
        interchainAccountFactories,
        multiProvider,
      );
    return new InterchainAccounts(contracts, intersectionProvider);
  }

  static fromEnvironment<Env extends HyperlaneEnvironment>(
    env: Env,
    multiProvider: MultiProvider,
  ): InterchainAccounts {
    const envAddresses = hyperlaneEnvironments[env];
    if (!envAddresses) {
      throw new Error(`No addresses found for ${env}`);
    }
    return InterchainAccounts.fromAddresses(envAddresses, multiProvider);
  }

  getContracts(chain: ChainName): InterchainAccountContracts {
    return super.getContracts(chain);
  }
}
