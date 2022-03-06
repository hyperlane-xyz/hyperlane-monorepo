import {
  UpgradeBeaconController,
  XAppConnectionManager,
  ValidatorManager,
  Outbox,
  Inbox,
} from '@abacus-network/abacus-sol/typechain';
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

  upgradeBeaconController(domain: types.Domain): UpgradeBeaconController {
    return this.instances[domain].upgradeBeaconController;
  }

  validatorManager(domain: types.Domain): ValidatorManager {
    return this.instances[domain].validatorManager;
  }

  outbox(domain: types.Domain): Outbox {
    return this.instances[domain].outbox;
  }

  inbox(local: types.Domain, remote: types.Domain): Inbox {
    return this.instances[local].inbox(remote);
  }

  xAppConnectionManager(domain: types.Domain): XAppConnectionManager {
    return this.instances[domain].xAppConnectionManager;
  }
}
