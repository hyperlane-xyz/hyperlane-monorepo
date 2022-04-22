import {
  AbacusConnectionManager,
  AbacusConnectionManager__factory,
  UpgradeBeaconController,
  UpgradeBeaconController__factory,
} from '@abacus-network/core';
import {
  GovernanceRouter,
  GovernanceRouter__factory,
} from '@abacus-network/apps';
import { types } from '@abacus-network/utils';

import { AbacusAppContracts } from '../contracts';
import { ProxiedAddress } from '../types';

export type GovernanceContractAddresses = {
  upgradeBeaconController: types.Address;
  abacusConnectionManager: types.Address;
  router: ProxiedAddress;
};

export class GovernanceContracts extends AbacusAppContracts<GovernanceContractAddresses> {
  get router(): GovernanceRouter {
    return GovernanceRouter__factory.connect(
      this.addresses.router.proxy,
      this.connection,
    );
  }

  get upgradeBeaconController(): UpgradeBeaconController {
    return UpgradeBeaconController__factory.connect(
      this.addresses.upgradeBeaconController,
      this.connection,
    );
  }

  get abacusConnectionManager(): AbacusConnectionManager {
    return AbacusConnectionManager__factory.connect(
      this.addresses.abacusConnectionManager,
      this.connection,
    );
  }
}
