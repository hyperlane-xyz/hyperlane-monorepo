import { Call } from '..';

import { GovernanceRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { AbacusContracts, routerFactories } from '../contracts';
import { ProxiedAddress } from '../types';

import { normalizeCall } from './utils';

export type GovernanceAddresses = {
  // Basically copy RouterAddresses
  abacusConnectionManager: types.Address;
  router: ProxiedAddress;
  upgradeBeaconController: types.Address;
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
