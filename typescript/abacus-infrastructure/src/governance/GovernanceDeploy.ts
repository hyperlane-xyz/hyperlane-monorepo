import { types } from '@abacus-network/utils';
import { ethers } from 'ethers';
import { ChainConfig, RouterDeploy } from '@abacus-network/abacus-deploy';
import { xapps } from '@abacus-network/ts-interface';
import { GovernanceInstance } from './GovernanceInstance';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from '../config/governance';

export class GovernanceDeploy extends RouterDeploy<
  GovernanceInstance,
  GovernanceConfig
> {
  async deployInstance(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<GovernanceInstance> {
    return GovernanceInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(config: GovernanceConfig) {
    await super.postDeploy(config);
    for (const domain of this.domains) {
      const governor = config.addresses[this.chains[domain].name].governor;
      if (governor !== undefined) {
        await this.router(domain).setGovernor(governor);
      } else {
        await this.router(domain).setGovernor(ethers.constants.AddressZero);
      }
    }
  }

  static fromObjects(
    chains: ChainConfig[],
    contracts: Record<types.Domain, GovernanceContracts>,
  ): GovernanceDeploy {
    const deploy = new GovernanceDeploy();
    for (const chain of chains) {
      deploy.instances[chain.domain] = new GovernanceInstance(
        chain,
        contracts[chain.domain],
      );
      deploy.chains[chain.domain] = chain;
    }
    return deploy;
  }

  router(domain: types.Domain): xapps.GovernanceRouter {
    return this.instances[domain].router;
  }
}
