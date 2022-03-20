import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { GovernanceRouter } from '@abacus-network/apps';
import { CommonDeploy, DeployType } from '../common';
import { ChainConfig } from '../config';
import { RouterDeploy } from '../router';
import { GovernanceInstance } from './GovernanceInstance';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';

export class GovernanceDeploy extends RouterDeploy<
  GovernanceInstance,
  GovernanceConfig
> {
  deployType = DeployType.GOVERNANCE;

  async deployInstance(
    domain: types.Domain,
    config: GovernanceConfig,
  ): Promise<GovernanceInstance> {
    return GovernanceInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(config: GovernanceConfig) {
    await super.postDeploy(config);
    for (const domain of this.domains) {
      const addresses = config.addresses[this.name(domain)];
      if (addresses === undefined) throw new Error('could not find addresses');
      if (addresses.governor !== undefined) {
        await this.router(domain).setGovernor(addresses.governor);
      } else {
        await this.router(domain).setGovernor(ethers.constants.AddressZero);
      }
    }
  }

  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): GovernanceDeploy {
    return CommonDeploy.readContractsHelper(
      GovernanceDeploy,
      GovernanceInstance,
      GovernanceContracts.readJson,
      chains,
      directory,
    );
  }

  router(domain: types.Domain): GovernanceRouter {
    return this.instances[domain].router;
  }
}
