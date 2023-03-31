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
import { objMap, pick } from './utils/objects';

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
    addresses: HyperlaneAddressesMap<F>,
    factories: F,
    multiProvider: MultiProvider,
  ): {
    contracts: HyperlaneContractsMap<F>;
    intersectionProvider: MultiProvider;
  } {
    const chains = Object.keys(addresses);
    const { intersection, multiProvider: intersectionProvider } =
      multiProvider.intersect(chains, true);

    const intersectionAddresses = pick(addresses, intersection);
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
