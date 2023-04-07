import {
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  attachContractsMap,
  coerceAddressesMap,
  connectContracts,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainName } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objFilter, objMap } from './utils/objects';

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
    // First, filter addressesMap down to match the HyperlaneAddressesMap<F> type
    const factoriesAddressesMap = coerceAddressesMap(addressesMap, factories);
    // Then, create contracts from that
    const contractsMap = attachContractsMap(factoriesAddressesMap, factories);

    // Filter out providers for chains for which we don't have a complete set
    // of addresses
    const intersection = multiProvider.intersect(Object.keys(contractsMap));

    // Filter out contracts for chains for which we don't have a provider
    const filteredContractsMap = objFilter(
      contractsMap,
      (chain, contracts): contracts is HyperlaneContracts<F> =>
        intersection.intersection.includes(chain),
    );

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
