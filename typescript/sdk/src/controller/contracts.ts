import { Call } from '..';

import { ControllerRouter__factory } from '@abacus-network/apps';
import { UpgradeBeaconController__factory } from '@abacus-network/core';
import { types } from '@abacus-network/utils';

import { AbacusContracts, routerFactories } from '../contracts';
import { ProxiedAddress } from '../types';

import { normalizeCall } from './utils';

export type ControllerAddresses = {
  // Basically copy RouterAddresses
  abacusConnectionManager: types.Address;
  router: ProxiedAddress;
  upgradeBeaconController: types.Address;
};

export const controllerFactories = {
  ...routerFactories,
  upgradeBeaconController: UpgradeBeaconController__factory.connect,
  router: ControllerRouter__factory.connect,
};

export type ControllerFactories = typeof controllerFactories;

export class ControllerContracts extends AbacusContracts<
  ControllerAddresses,
  ControllerFactories
> {
  // necessary for factories be defined in the constructor
  factories() {
    return controllerFactories;
  }
  calls: Call[] = [];

  push = (call: Call) => this.calls.push(normalizeCall(call));
  router = this.contracts.router;
  controller = () => this.router.controller();
}
