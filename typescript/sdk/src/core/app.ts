import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainName, Remotes } from '../types';

import {
  CoreContractAddresses,
  CoreContractSchema,
  CoreContracts,
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
    super(CoreContracts, networkAddresses, multiProvider);
  }

  static fromEnvironment(
    name: EnvironmentName,
    multiProvider: MultiProvider<keyof Environments[typeof name]>,
  ) {
    return new AbacusCore(environments[name], multiProvider);
  }

  // override type to be derived from network key
  getContracts<Local extends Networks>(
    network: Local,
  ): CoreContractSchema<Networks, Local> {
    return super.getContracts(network) as any;
  }

  // override type to be derived from network key
  getAddresses<Local extends Networks>(
    network: Local,
  ): CoreContractAddresses<Networks, Local> {
    return super.getAddresses(network) as any;
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
