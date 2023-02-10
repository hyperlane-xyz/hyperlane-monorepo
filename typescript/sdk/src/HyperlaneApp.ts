import {
  HyperlaneAddresses,
  HyperlaneContracts,
  connectContracts,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, ChainName } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objMap } from './utils/objects';

export class HyperlaneApp<
  Contracts extends HyperlaneContracts,
> extends MultiGeneric<Contracts> {
  constructor(
    public readonly contractsMap: ChainMap<Contracts>,
    public readonly multiProvider: MultiProvider,
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(contracts, multiProvider.getProvider(chain)),
    );
    super(connectedContractsMap);
  }

  getContracts(chain: ChainName): Contracts {
    return this.get(chain);
  }

  getAddresses(chain: ChainName): HyperlaneAddresses {
    return serializeContracts(this.get(chain));
  }
}
