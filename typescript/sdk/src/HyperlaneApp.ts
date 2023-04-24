import {
  HyperlaneAddresses,
  HyperlaneContracts,
  HyperlaneContractsMap,
  HyperlaneFactories,
  connectContracts,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainName } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objMap } from './utils/objects';

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

  getContracts(chain: ChainName): HyperlaneContracts<Factories> {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses<Factories> {
    return serializeContracts(this.get(chain));
  }
}
