import {
  XAppConnectionManager,
  XAppConnectionManager__factory,
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
  xAppConnectionManager: types.Address;
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

  get xAppConnectionManager(): XAppConnectionManager {
    return XAppConnectionManager__factory.connect(
      this.addresses.xAppConnectionManager,
      this.connection,
    );
  }
}
