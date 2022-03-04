import { core } from '@abacus-network/ts-interface';
import { ChainConfig, Domain } from '../types';
import { Deploy } from '../deploy';
import { CoreConfig } from './types';
import { CoreInstance } from './CoreInstance';

export class CoreDeploy extends Deploy<CoreInstance, CoreConfig> {
  deployInstance(
      chain: ChainConfig,
      config: CoreConfig,
  ): Promise<CoreInstance> {
    return CoreInstance.deploy(
      chain,
      config,
    );
  }

  async postDeploy(_: CoreConfig) {}

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
