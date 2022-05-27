import { Inbox, Outbox } from '@abacus-network/core';

import { AbacusApp } from '../app';
import { AbacusAddresses } from '../contracts';
import { ChainMap, ChainName, Remotes } from '../types';

import { CoreContracts, coreFactories } from './contracts';
import { environments } from './environments';

export type CoreEnvironment = keyof typeof environments;
export type CoreEnvironmentChain<E extends CoreEnvironment> = Extract<
  keyof typeof environments[E],
  ChainName
>;

export class AbacusCore<Chain extends ChainName = ChainName> extends AbacusApp<
  CoreContracts<Chain, Chain>,
  Chain
> {
  constructor(addressesMap: ChainMap<Chain, AbacusAddresses>) {
    super(addressesMap, coreFactories);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
  ): AbacusCore<CoreEnvironmentChain<Env>> {
    return new AbacusCore(
      environments[env] as ChainMap<CoreEnvironmentChain<Env>, AbacusAddresses>,
    );
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(chain: Local): CoreContracts<Chain, Local> {
    /* eslint-disable  @typescript-eslint/no-explicit-any */
    return super.getContracts(chain) as any;
  }

  getMailboxPair<Local extends Chain>(
    origin: Remotes<Chain, Local>,
    destination: Local,
  ): { originOutbox: Outbox; destinationInbox: Inbox } {
    const originOutbox = this.getContracts(origin).outbox.outbox;
    const destinationInbox =
      this.getContracts(destination).inboxes[origin].inbox;
    return { originOutbox, destinationInbox };
  }
}
