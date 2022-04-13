import { Inbox, InboxValidatorManager } from '@abacus-network/core';

import { AbacusApp } from '../app';
import { domains } from '../domains';
import { ChainName, NameOrDomain } from '../types';

import { CoreContractAddresses, CoreContracts } from './contracts';
import { addresses } from './environments';

export class AbacusCore extends AbacusApp<
  CoreContractAddresses,
  CoreContracts
> {
  constructor(
    addressesOrEnv: Partial<Record<ChainName, CoreContractAddresses>> | string,
  ) {
    super();
    let _addresses: Partial<Record<ChainName, CoreContractAddresses>> = {};
    if (typeof addressesOrEnv == 'string') {
      _addresses = addresses[addressesOrEnv];
      if (!_addresses)
        throw new Error(
          `addresses for environment ${addressesOrEnv} not found`,
        );
    } else {
      _addresses = addressesOrEnv;
    }
    console.log(_addresses);
    const chains = Object.keys(_addresses) as ChainName[];
    chains.map((chain) => {
      this.registerDomain(domains[chain]);
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new CoreContracts(_addresses[chain]!));
    });
  }

  mustGetInbox(src: NameOrDomain, dest: NameOrDomain): Inbox {
    const contracts = this.mustGetContracts(dest);
    const srcName = this.mustGetDomain(src).name;
    return contracts.inbox(srcName);
  }

  mustGetInboxValidatorManager(
    src: NameOrDomain,
    dest: NameOrDomain,
  ): InboxValidatorManager {
    const contracts = this.mustGetContracts(dest);
    const srcName = this.mustGetDomain(src).name;
    return contracts.inboxValidatorManager(srcName);
  }
}
