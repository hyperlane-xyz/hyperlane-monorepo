import {
  HyperlaneEnvironment,
  hyperlaneEnvironments,
} from '../../consts/environments';
import { HyperlaneAddresses } from '../../contracts';
import { MultiProvider } from '../../providers/MultiProvider';
import { RouterApp } from '../../router/RouterApps';
import { ChainMap, ChainName } from '../../types';

import {
  InterchainQueryContracts,
  interchainQueryFactories,
} from './contracts';

export type InterchainQueryContractsMap = ChainMap<InterchainQueryContracts>;

export class InterchainQuery extends RouterApp<InterchainQueryContracts> {
  constructor(
    contractsMap: InterchainQueryContractsMap,
    multiProvider: MultiProvider,
  ) {
    super(contractsMap, multiProvider);
  }

  static fromAddresses(
    addresses: ChainMap<HyperlaneAddresses>,
    multiProvider: MultiProvider,
  ): InterchainQuery {
    const { contracts, intersectionProvider } =
      this.buildContracts<InterchainQueryContracts>(
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

  getContracts(chain: ChainName): InterchainQueryContracts {
    return super.getContracts(chain);
  }
}
