import {
  AbacusAddresses,
  AbacusContracts,
  AbacusFactories,
  connectContracts,
  deepAttach,
  serializeToAddresses,
} from './contracts';
import { ChainMap, ChainName, Connection } from './types';
import { MultiGeneric, objMap } from './utils';

export class AbacusApp<
  Contracts extends AbacusContracts,
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, Contracts> {
  constructor(public contractsMap: ChainMap<Chain, Contracts>) {
    super(contractsMap);
  }

  static buildContracts<
    Contracts extends AbacusContracts,
    Chain extends ChainName,
  >(
    addressesMap: ChainMap<Chain, AbacusAddresses>,
    factories: AbacusFactories,
  ): ChainMap<Chain, Contracts> {
    return objMap(
      addressesMap,
      (_, addresses) => deepAttach(addresses, factories) as Contracts,
    );
  }

  getContracts(chain: Chain): Contracts {
    return this.get(chain);
  }

  getAddresses(chain: Chain): AbacusAddresses {
    return serializeToAddresses(this.get(chain));
  }

  connect(chain: Chain, connection: Connection): void {
    this.set(chain, connectContracts(this.get(chain), connection));
  }
}
