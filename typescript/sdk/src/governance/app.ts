import { ethers } from 'ethers';
import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';

import { AbacusApp } from '../app';
import { AbacusAppContracts } from '../contracts';
import { ChainName, ProxiedAddress } from '../types';

export type Governor = {
  domain: number;
  identifier: string;
};

export class GovernanceContracts extends AbacusAppContracts<ProxiedAddress> {
  get router(): GovernanceRouter {
    return GovernanceRouter__factory.connect(this._addresses.proxy, this.connection);
  }
}

export class Governance extends AbacusApp<ProxiedAddress, GovernanceContracts> {
  constructor(addresses: Record<ChainName, ProxiedAddress>) {
    super();
    for (const chain of Object.keys(addresses) as ChainName[]) {
      const domain = this.resolveDomain(chain);
      this.contracts.set(domain, new GovernanceContracts(addresses[chain]!))
    }
  }

  /**
   * Returns the governors of this abacus deployment.
   *
   * @returns The governors of the deployment
   */
  async governors(): Promise<Governor[]> {
    const governorDomains = Array.from(this.contracts.keys())
    const governorAddresses = await Promise.all(
      governorDomains.map((domain) => this.mustGetContracts(domain).router.governor())
    )
    const governors: Governor[] = [];
    for (let i = 0; i < governorAddresses.length; i++) {
      if (governorAddresses[i] !== ethers.constants.AddressZero) {
        governors.push({ identifier: governorAddresses[i], domain: governorDomains[i] })
      }
    }
    if (governors.length === 0) throw new Error('no governors');
    return governors;
  }

  /**
   * Returns the single governor of this deployment, throws an error if not found.
   *
   * @returns The governor of the deployment
   */
  async governor(): Promise<Governor> {
    const governors = await this.governors();
    if (governors.length !== 1) throw new Error('multiple governors');
    return governors[0];
  }
}
