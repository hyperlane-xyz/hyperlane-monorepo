import { ContractsBuilder, IAbacusContracts } from './contracts';
import { MultiProvider } from './provider';
import { ChainName, ChainMap, Connection } from './types';
import { MultiGeneric, objMap } from './utils';

export class AbacusApp<
  Contracts extends IAbacusContracts<any, any>,
  Networks extends ChainName = ChainName,
> extends MultiGeneric<Contracts, Networks> {
  constructor(
    builder: ContractsBuilder<any, Contracts>,
    networkAddresses: ChainMap<Networks, any>,
    multiProvider: MultiProvider<Networks>,
  ) {
    super(
      objMap(
        networkAddresses,
        (network, addresses) =>
          new builder(
            addresses,
            multiProvider.getDomainConnection(network).getConnection()!,
          ),
      ),
    );
  }

  public contractsMap = this.domainMap;

  getContracts(
    network: Networks,
  ): Contracts extends IAbacusContracts<any, infer C> ? C : never {
    return this.get(network).contracts;
  }

  getAddresses(
    network: Networks,
  ): Contracts extends IAbacusContracts<infer A, any> ? A : never {
    return this.get(network).addresses;
  }

  reconnect(network: Networks, connection: Connection) {
    this.get(network).reconnect(connection);
  }
}
