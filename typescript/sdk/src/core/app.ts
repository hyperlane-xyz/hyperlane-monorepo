import { Inbox, Outbox } from '@abacus-network/core';

import { AbacusApp } from '../app';
import { buildContracts } from '../contracts';
import { MultiProvider } from '../provider';
import { ChainName, Remotes } from '../types';

import { CoreContracts, coreFactories } from './contracts';
import { environments } from './environments';

export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export type CoreContractsMap<Chain extends ChainName> = {
  [local in Chain]: CoreContracts<Chain, local>;
};

export class AbacusCore<Chain extends ChainName = ChainName> extends AbacusApp<
  CoreContracts<Chain, Chain>,
  Chain
> {
  constructor(
    contractsMap: CoreContractsMap<Chain>,
    multiProvider: MultiProvider<Chain>,
  ) {
    super(contractsMap, multiProvider);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
    multiProvider: MultiProvider<CoreEnvironmentChain<Env>>,
  ): AbacusCore<CoreEnvironmentChain<Env>> {
    const contractsMap = buildContracts(
      environments[env],
      coreFactories,
    ) as CoreContractsMap<CoreEnvironmentChain<Env>>;
    return new AbacusCore(contractsMap, multiProvider);
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(chain: Local): CoreContracts<Chain, Local> {
    return super.getContracts(chain) as CoreContracts<Chain, Local>;
  }

  getMailboxPair<Local extends Chain>(
    origin: Remotes<Chain, Local>,
    destination: Local,
  ): { originOutbox: Outbox; destinationInbox: Inbox } {
    const originOutbox = this.getContracts(origin).outbox.contract;
    const destinationInbox =
      this.getContracts(destination).inboxes[origin].inbox.contract;
    return { originOutbox, destinationInbox };
  }
}
