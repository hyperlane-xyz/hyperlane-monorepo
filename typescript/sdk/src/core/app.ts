import { Inbox } from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { AbacusApp } from '../app';
import { domains } from '../domains';
import { ChainName, NameOrDomain } from '../types';

import { CoreContractAddresses, CoreContracts } from './contracts';

export class AbacusCore extends AbacusApp<
  CoreContractAddresses,
  CoreContracts
> {
  constructor(addresses: Partial<Record<ChainName, CoreContractAddresses>>) {
    super();
    const chains = Object.keys(addresses) as ChainName[];
    chains.map((chain) => {
      this.registerDomain(domains[chain]);
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new CoreContracts(addresses[chain]!));
    });
  }

  mustGetInbox(src: NameOrDomain, dest: NameOrDomain): Inbox {
    const contracts = this.mustGetContracts(dest);
    const srcName = this.mustGetDomain(src).name;
    return contracts.inbox(srcName);
  }

  // TODO(asa): confirmations
  async transferOwnership(
    owners: Record<number, types.Address>,
  ): Promise<void> {
    await Promise.all(
      this.domainNumbers.map((domain) => {
        const owner = owners[domain];
        if (!owner) throw new Error(`Missing owner for ${domain}`);
        return this.mustGetContracts(domain).transferOwnership(
          owner,
          this.getOverrides(domain),
        );
      }),
    );
  }
}
