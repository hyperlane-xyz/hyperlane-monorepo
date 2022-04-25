import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainName, Remotes } from '../types';
import { objMap } from '../utils';
import { CoreContracts } from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class AbacusCore<
  Networks extends ChainName = ChainName,
> extends AbacusApp<CoreContracts, Networks> {
  getContracts<Local extends Networks>(
    network: Local,
  ): CoreContracts<Networks, Local> {
    return this.get(network).contracts as any;
  }

  getMailboxPair<Local extends Networks>(
    origin: Remotes<Networks, Local>,
    destination: Local,
  ) {
    const outbox = this.getContracts(origin).contracts.outbox.outbox;
    const inbox = this.getContracts(destination).getInbox(origin);
    return { outbox, inbox };
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    const env = environments[name];
    type Networks = keyof typeof env;
    const contractsMap = objMap(env, (network, addresses) => {
      const connection = multiProvider
        .getDomainConnection(network)
        .getConnection();
      if (!connection) {
        throw new Error(
          `No connection found for network ${network} in environment ${name}`,
        );
      }
      return new CoreContracts<Networks>(addresses, connection);
    }) as {
      [local in Networks]: CoreContracts<Networks, local>;
    }; // necessary to get mapped types for core contracts

    return new AbacusCore(contractsMap);
  }
}
