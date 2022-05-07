import { Call } from '..';

import { GovernanceRouter__factory } from '@abacus-network/apps';

import {
  AbacusContracts,
  RouterAddresses,
  routerFactories,
} from '../contracts';

import { normalizeCall } from './utils';
import { types } from '@abacus-network/utils';
import { UpgradeBeaconController__factory } from '@abacus-network/core';

export type GovernanceAddresses = RouterAddresses & {
  upgradeBeaconController: types.Address
};

export const governanceFactories = {
  ...routerFactories,
  upgradeBeaconController: UpgradeBeaconController__factory.connect,
  router: GovernanceRouter__factory.connect,
};

export type GovernanceFactories = typeof governanceFactories;

export class GovernanceContracts extends AbacusContracts<
  GovernanceAddresses,
  GovernanceFactories
> {
  // necessary for factories be defined in the constructor
  factories() {
    return governanceFactories;
  }
  calls: Call[] = [];

  push = (call: Call) => this.calls.push(normalizeCall(call));
  router = this.contracts.router;
  governor = () => this.router.governor();
}
