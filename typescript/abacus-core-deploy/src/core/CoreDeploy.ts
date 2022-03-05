import { core } from '@abacus-network/ts-interface';
import { types } from '@abacus-network/utils';
import { Deploy } from '../deploy';
import { CoreConfig } from './types';
import { CoreInstance } from './CoreInstance';

export class CoreDeploy extends Deploy<CoreInstance, CoreConfig> {
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
}
