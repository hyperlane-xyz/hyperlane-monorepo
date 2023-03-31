import {
  HyperlaneAddresses,
  HyperlaneAddressesMap,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  buildContracts,
  connectContracts,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, ChainName } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objFilter, objMap, pick } from './utils/objects';

export class HyperlaneApp<
  Factories extends HyperlaneFactories,
> extends MultiGeneric<HyperlaneContracts<Factories>> {
  constructor(
    public readonly contractsMap: ChainMap<HyperlaneContracts<Factories>>,
    public readonly multiProvider: MultiProvider,
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(contracts, multiProvider.getSignerOrProvider(chain)),
    );
    super(connectedContractsMap);
  }

  static buildContracts<F extends HyperlaneFactories>(
    addresses: HyperlaneAddressesMap<any>,
    factories: F,
    multiProvider: MultiProvider,
  ): {
    contracts: HyperlaneContractsMap<F>;
    intersectionProvider: MultiProvider;
  } {
    const filteredAddresses = objFilter(
      addresses,
      (chain, addrs): addrs is HyperlaneAddresses<F> => {
        return Object.keys(factories).every((contract) =>
          Object.keys(addrs).includes(contract),
        );
      },
    );
    const chains = Object.keys(filteredAddresses);
    const { intersection, multiProvider: intersectionProvider } =
      multiProvider.intersect(chains, true);

    const intersectionAddresses = pick(filteredAddresses, intersection);
    const contracts = objMap(intersectionAddresses, (_, addresses) =>
      buildContracts(addresses, factories),
    );

    return { contracts, intersectionProvider };
  }

  getContracts(chain: ChainName): HyperlaneContracts<Factories> {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses<Factories> {
    return serializeContracts(this.get(chain));
  }
}
