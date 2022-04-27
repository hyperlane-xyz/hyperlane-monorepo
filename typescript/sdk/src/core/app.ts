import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainName, Remotes } from '../types';
import { objMap } from '../utils';
import {
  CoreContractAddresses,
  CoreContracts,
  CoreContractSchema,
} from './contracts';
import { environments } from './environments';

type Environments = typeof environments;
type EnvironmentName = keyof Environments;

export class AbacusCore<
  Networks extends ChainName = ChainName,
> extends AbacusApp<CoreContracts<Networks>, Networks> {
  constructor(
    networkAddresses: {
      [local in Networks]: CoreContractAddresses<Networks, local>;
    },
    multiProvider: MultiProvider<Networks>,
  ) {
    super(
      objMap<Networks, any, any>(networkAddresses, (local, addresses) => {
        return new CoreContracts<Networks, typeof local>(
          addresses,
          multiProvider.getDomainConnection(local).getConnection()!,
        );
      }),
    );
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    return new AbacusCore(environments[name], multiProvider);
  }

  getContracts<Local extends Networks>(
    network: Local,
  ): CoreContractSchema<Networks, Local> {
    return this.get(network).contracts as any;
  }

  getMailboxPair<Local extends Networks>(
    origin: Remotes<Networks, Local>,
    destination: Local,
  ) {
    const outbox = this.getContracts(origin).outbox.outbox;
    const inbox = this.getContracts(destination).inboxes[origin].inbox;
    return { outbox, inbox };
  }
}
