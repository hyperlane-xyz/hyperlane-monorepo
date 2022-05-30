import { AbacusApp } from '../app';
import { MultiProvider } from '../provider';
import { ChainMap, ChainName, Remotes } from '../types';
import { objMap } from '../utils';

import {
  CoreContractAddresses,
  CoreContractSchema,
  CoreContracts,
} from './contracts';
import { environments } from './environments';

export const CoreEnvironments = Object.keys(environments);
export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export class AbacusCore<Chain extends ChainName = ChainName> extends AbacusApp<
  CoreContracts<Chain>,
  Chain
> {
  constructor(
    addresses: {
      [local in Chain]: CoreContractAddresses<Chain, local>;
    },
    multiProvider: MultiProvider<Chain>,
  ) {
    super(CoreContracts, addresses, multiProvider);
  }

  static fromEnvironment<E extends CoreEnvironment>(
    name: E,
    multiProvider: MultiProvider<any>, // TODO: fix networks
  ) {
    return new AbacusCore(environments[name], multiProvider);
  }

  extendWithConnectionManagers<T>(
    config: ChainMap<Chain, T>,
  ): ChainMap<Chain, T & { abacusConnectionManager: string }> {
    return objMap(config, (chain, config) => ({
      ...config,
      abacusConnectionManager:
        this.getContracts(chain).abacusConnectionManager.address,
    }));
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(
    chain: Local,
  ): CoreContractSchema<Chain, Local> {
    return super.getContracts(chain) as any;
  }

  // override type to be derived from chain key
  getAddresses<Local extends Chain>(
    chain: Local,
  ): CoreContractAddresses<Chain, Local> {
    return super.getAddresses(chain) as any;
  }

  getMailboxPair<Local extends Chain>(
    origin: Remotes<Chain, Local>,
    destination: Local,
  ) {
    const outbox = this.getContracts(origin).outbox.outbox;
    const inbox = this.getContracts(destination).inboxes[origin].inbox;
    return { outbox, inbox };
  }
}
