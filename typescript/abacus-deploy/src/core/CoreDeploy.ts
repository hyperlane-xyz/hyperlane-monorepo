import path from 'path';
import { ethers } from 'ethers';
import { types } from '@abacus-network/utils';
import { core } from '@abacus-network/ts-interface';
import {
  ChainConfig,
  CoreContracts,
  CoreConfig,
} from '@abacus-network/abacus-deploy';
import { CoreInstance } from './CoreInstance';
import { CommonDeploy } from '../common';

export class CoreDeploy extends CommonDeploy<CoreInstance, CoreConfig> {
  deployInstance(
    domain: types.Domain,
    config: CoreConfig,
  ): Promise<CoreInstance> {
    return CoreInstance.deploy(domain, this.chains, config);
  }

  async postDeploy(_: CoreConfig) {}

  upgradeBeaconController(domain: types.Domain): core.UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  validatorManager(domain: types.Domain): core.ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  outbox(domain: types.Domain): core.Outbox {
    return this.instances[domain].outbox;
  }

  inbox(local: types.Domain, remote: types.Domain): core.Inbox {
    return this.instances[local].inbox(remote);
  }

  xAppConnectionManager(domain: types.Domain): core.XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }

  // TODO(asa): Dedupe
  static readContracts(
    chains: Record<types.Domain, ChainConfig>,
    directory: string,
  ): CoreDeploy {
    const deploy = new CoreDeploy();
    const domains = Object.keys(chains).map((d) => parseInt(d));
    for (const domain of domains) {
      const chain = chains[domain];
      const contracts = CoreContracts.readJson(
        path.join(directory, `${chain.name}_contracts.json`),
        chain.signer.provider! as ethers.providers.JsonRpcProvider,
      );
      deploy.chains[domain] = chain;
      deploy.instances[domain] = new CoreInstance(chain, contracts);
    }
    return deploy;
  }
}
