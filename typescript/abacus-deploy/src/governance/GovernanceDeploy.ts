import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { xapps } from '@abacus-network/ts-interface';
import { ChainConfig } from '../config';
import { RouterDeploy } from '../router';
import { GovernanceInstance } from './GovernanceInstance';
import { GovernanceContracts } from './GovernanceContracts';
import { GovernanceConfig } from './types';

export class GovernanceDeploy extends RouterDeploy<
  GovernanceInstance,
  GovernanceConfig
> {
  deployName = 'governance';

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
    const deploy = new GovernanceDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = GovernanceContracts.readJson(
        path.join(directory, 'governance', 'contracts', `${chain.name}.json`),
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
