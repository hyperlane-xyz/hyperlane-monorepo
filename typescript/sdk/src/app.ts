import { ContractsBuilder, IAbacusContracts } from './contracts';
import { MultiProvider } from './provider';
import { ChainMap, ChainName, Connection } from './types';
import { MultiGeneric, objMap } from './utils';

export class AbacusApp<
  Contracts extends IAbacusContracts<any, any>,
  Chain extends ChainName = ChainName,
> extends MultiGeneric<Chain, Contracts> {
  constructor(
    builder: ContractsBuilder<any, Contracts>,
    contractAddresses: ChainMap<Chain, any>,
    readonly multiProvider: MultiProvider<Chain>,
  ) {
    super(
      objMap(
        contractAddresses,
        (chain, addresses) =>
          new builder(
            addresses,
            multiProvider.getChainConnection(chain).getConnection()!,
          ),
      ),
    );
  }

  public contractsMap = this.chainMap;

  getContracts(
    chain: Chain,
  ): Contracts extends IAbacusContracts<any, infer C> ? C : never {
    return this.get(chain).contracts;
  }

  getAddresses(
    chain: Chain,
  ): Contracts extends IAbacusContracts<infer A, any> ? A : never {
    return this.get(chain).addresses;
  }

  reconnect(chain: Chain, connection: Connection) {
    this.get(chain).reconnect(connection);
  }
}
