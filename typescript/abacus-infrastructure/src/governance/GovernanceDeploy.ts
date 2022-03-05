import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { ChainConfig } from '@abacus-network/abacus-deploy';
import { xapps } from '@abacus-network/ts-interface';
import { GovernanceInstance } from './GovernanceInstance';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';
import { InfraRouterDeploy } from '../deploy';

export class GovernanceDeploy extends InfraRouterDeploy<
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

  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): GovernanceDeploy {
    const deploy = new GovernanceDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = GovernanceContracts.readJson(
        path.join(directory, `${chain.name}_contracts.json`),
        chain.signer.provider! as ethers.providers.JsonRpcProvider,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new GovernanceInstance(chain, contracts);
    }
    return deploy;
  }

  router(domain: types.Domain): xapps.GovernanceRouter {
    return this.instances[domain].router;
  }
}
