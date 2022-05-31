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
  constructor(contractsMap: {
    [local in Chain]: CoreContracts<Chain, local>;
  }) {
    super(contractsMap);
  }

  static fromEnvironment<Env extends CoreEnvironment>(
    env: Env,
  ): AbacusCore<any> {
    const addressesMap = environments[env] as ChainMap<
      CoreEnvironmentChain<Env>,
      AbacusAddresses
    >;
    const contractsMap = this.buildContracts(addressesMap, coreFactories);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new AbacusCore(contractsMap as any);
  }

  // override type to be derived from chain key
  getContracts<Local extends Chain>(chain: Local): CoreContracts<Chain, Local> {
    return super.getContracts(chain) as CoreContracts<Chain, Local>;
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
