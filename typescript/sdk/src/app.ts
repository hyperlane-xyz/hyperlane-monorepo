import {
  AbacusAddresses,
  AbacusContracts,
  AbacusFactories,
  addresses,
  attach,
  connect,
} from './contracts';
import { ChainMap, ChainName, Connection } from './types';
import { MultiGeneric, objMap } from './utils';

export class AbacusApp<
  Contracts extends AbacusContracts,
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, Contracts> {
  constructor(
    addressesMap: ChainMap<Chain, AbacusAddresses>,
    factories: AbacusFactories,
  ) {
    super(
      objMap(
        addressesMap,
        (_, addresses) => attach(addresses, factories) as Contracts,
      ),
    );
  }

  getContracts(chain: Chain): Contracts {
    return this.get(chain);
  }

  getAddresses(chain: Chain): AbacusAddresses {
    return addresses(this.get(chain));
  }

  reconnect(chain: Chain, connection: Connection): void {
    connect(this.get(chain), connection);
  }
}
