import { core } from '@abacus-network/ts-interface';
import { ChainConfig, Domain } from '../types';
import { Deploy } from '../deploy';
import { CoreConfig } from './types';
import { CoreInstance } from './CoreInstance';

export class CoreDeploy extends Deploy<CoreInstance> {
  // TODO(asa): Can this be moved to Deploy?
  static async deploy(
    chains: Record<number, ChainConfig>,
    config: CoreConfig,
  ): Promise<CoreDeploy> {
    const domains = Object.keys(chains).map((d) => parseInt(d));
    const instances: Record<number, CoreInstance> = {};
    for (const domain of domains) {
      instances[domain] = await CoreInstance.deploy(
        domains,
        chains[domain],
        config,
      );
    }
    const deploy = new CoreDeploy(instances);
    return deploy;
  }

  upgradeBeaconController(domain: Domain): core.UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController
  }

  validatorManager(domain: Domain): core.ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  outbox(domain: Domain): core.Outbox {
    return this.instances[domain].outbox.proxy;
  }

  inbox(local: Domain, remote: Domain): core.Inbox {
    return this.instances[local].inbox(remote).proxy;
  }

  xAppConnectionManager(domain: Domain): core.XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }
}
