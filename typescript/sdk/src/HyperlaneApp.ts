import {
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  attachContractsMap,
  connectContracts,
  filterAddressesMap,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainName } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objMap, pick } from './utils/objects';

export class HyperlaneApp<
  Factories extends HyperlaneFactories,
> extends MultiGeneric<HyperlaneContracts<Factories>> {
  constructor(
    public readonly contractsMap: HyperlaneContractsMap<Factories>,
    public readonly multiProvider: MultiProvider,
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
    );
    super(connectedContractsMap);
  }

  static fromAddressesMap<F extends HyperlaneFactories>(
    addressesMap: HyperlaneAddressesMap<any>,
    factories: F,
    multiProvider: MultiProvider,
  ): { contractsMap: HyperlaneContractsMap<F>; multiProvider: MultiProvider } {
    // Attaches contracts for each chain for which we have a complete set of
    // addresses
    const contractsMap = attachContractsMap(
      filterAddressesMap(addressesMap, factories),
      factories,
    );

    // Filters out providers for chains for which we don't have a complete set
    // of addresses
    const intersection = multiProvider.intersect(Object.keys(contractsMap));

    // Filters out contracts for chains for which we don't have a provider
    const filteredContractsMap = pick(contractsMap, intersection.intersection);

    return {
      contractsMap: filteredContractsMap,
      multiProvider: intersection.multiProvider,
    };
  }

  getContracts(chain: ChainName): HyperlaneContracts<Factories> {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses<Factories> {
    return serializeContracts(this.get(chain));
  }
}
