import { RouterDeploy, ChainConfig } from '@abacus-network/abacus-deploy';
import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { BridgeConfig } from '../config/bridge';
import { BridgeInstance } from './BridgeInstance';
import { BridgeContracts } from './BridgeContracts';

export class BridgeDeploy extends RouterDeploy<BridgeInstance, BridgeConfig> {
  async deployInstance(
    domain: types.Domain,
    config: BridgeConfig,
  ): Promise<BridgeInstance> {
    return BridgeInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(config: BridgeConfig) {
    await super.postDeploy(config);
    /*
    // after all peer BridgeRouters have been co-enrolled,
    // transfer ownership of BridgeRouters to Governance
    await Promise.all(
      deploys.map(async (deploy) => {
        await transferOwnershipToGovernance(deploy);
      }),
    );
    */
  }

  writeContracts(directory: string) {
    for (const domain of this.domains) {
      this.instances[domain].contracts.writeJson(
        `${this.chains[domain].name}_contracts.json`,
      );
    }
  }

  static fromObjects(
    chains: ChainConfig[],
    contracts: Record<types.Domain, BridgeContracts>,
  ): BridgeDeploy {
    const deploy = new BridgeDeploy();
    for (const chain of chains) {
      deploy.instances[chain.domain] = new BridgeInstance(
        chain,
        contracts[chain.domain],
      );
      deploy.chains[chain.domain] = chain;
    }
    return deploy;
  }

  token(domain: types.Domain): xapps.BridgeToken {
    return this.instances[domain].token;
  }

  router(domain: types.Domain): xapps.BridgeRouter {
    return this.instances[domain].router;
  }

  helper(domain: types.Domain): xapps.ETHHelper | undefined {
    return this.instances[domain].helper;
  }
}
