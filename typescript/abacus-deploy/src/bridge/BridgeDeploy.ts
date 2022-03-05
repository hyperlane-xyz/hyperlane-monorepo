import path from 'path';
import { ethers } from 'ethers';
import { ChainConfig } from '@abacus-network/abacus-deploy';
import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { BridgeConfig } from './types';
import { BridgeInstance } from './BridgeInstance';
import { BridgeContracts } from './BridgeContracts';
import { RouterDeploy } from '../router';

export class BridgeDeploy extends RouterDeploy<BridgeInstance, BridgeConfig> {
  async deployInstance(
    domain: types.Domain,
    config: BridgeConfig,
  ): Promise<BridgeInstance> {
    return BridgeInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(config: BridgeConfig) {
    await super.postDeploy(config);
  }

  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): BridgeDeploy {
    const deploy = new BridgeDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = BridgeContracts.readJson(
        path.join(directory, `${chain.name}_contracts.json`),
        chain.signer.provider! as ethers.providers.JsonRpcProvider,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new BridgeInstance(chain, contracts);
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
