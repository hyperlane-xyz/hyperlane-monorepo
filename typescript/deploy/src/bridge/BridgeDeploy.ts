import { BridgeToken, BridgeRouter, ETHHelper } from '@abacus-network/apps';
import { types } from '@abacus-network/utils';
import { BridgeConfig } from './types';
import { BridgeInstance } from './BridgeInstance';
import { BridgeContracts } from './BridgeContracts';
import { CommonDeploy, DeployType } from '../common';
import { ChainConfig } from '../config';
import { RouterDeploy } from '../router';

export class BridgeDeploy extends RouterDeploy<BridgeInstance, BridgeConfig> {
  deployType = DeployType.BRIDGE;

  async deployInstance(
    domain: types.Domain,
    config: BridgeConfig,
  ): Promise<BridgeInstance> {
    return BridgeInstance.deploy(domain, this.chains, config);
  }

  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): BridgeDeploy {
    return CommonDeploy.readContractsHelper(
      BridgeDeploy,
      BridgeInstance,
      BridgeContracts.readJson,
      chains,
      directory,
    );
  }

  token(domain: types.Domain): BridgeToken {
    return this.instances[domain].token;
  }

  router(domain: types.Domain): BridgeRouter {
    return this.instances[domain].router;
  }

  helper(domain: types.Domain): ETHHelper | undefined {
    return this.instances[domain].helper;
  }
}
