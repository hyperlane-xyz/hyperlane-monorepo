import {
  AbacusAddresses,
  AbacusContracts,
  connectContracts,
  serializeContracts,
} from './contracts';
import { MultiProvider } from './providers/MultiProvider';
import { ChainMap, ChainName, Connection } from './types';
import { MultiGeneric } from './utils/MultiGeneric';
import { objMap } from './utils/objects';

export class AbacusApp<
  Contracts extends AbacusContracts,
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, Contracts> {
  constructor(
    public readonly contractsMap: ChainMap<Chain, Contracts>,
    public readonly multiProvider: MultiProvider<Chain>,
  ) {
    const connectedContractsMap = objMap(contractsMap, (chain, contracts) =>
      connectContracts(
        contracts,
        multiProvider.getChainConnection(chain).getConnection(),
      ),
    );
    super(connectedContractsMap);
  }

  getContracts(chain: Chain): Contracts {
    return this.get(chain);
  }

  getAddresses(chain: Chain): AbacusAddresses {
    return serializeContracts(this.get(chain));
  }

  connectToChain(chain: Chain, connection: Connection): void {
    this.set(chain, connectContracts(this.get(chain), connection));
  }
}
