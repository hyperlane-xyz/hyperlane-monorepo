import { xapps } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { BridgeConfig } from './types';
import { BridgeInstance } from './BridgeInstance';
import { BridgeContracts } from './BridgeContracts';
import { CommonDeploy } from '../common';
import { ChainConfig } from '../config';
import { RouterDeploy } from '../router';

export class BridgeDeploy extends RouterDeploy<BridgeInstance, BridgeConfig> {
  deployName = 'bridge';

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
