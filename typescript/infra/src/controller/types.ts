import { RouterConfig } from '@abacus-network/deploy';
import { types } from '@abacus-network/utils';

export type ControllerConfigAddresses = {
  recoveryManager: types.Address;
  controller?: types.Address;
};

export type ControllerConfig = RouterConfig &
  ControllerConfigAddresses & { recoveryTimelock: number };
