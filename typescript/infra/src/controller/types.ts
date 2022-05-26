import { types } from '@abacus-network/utils';

export type ControllerConfigAddresses = {
  recoveryManager: types.Address;
  controller?: types.Address;
};

export type ControllerConfig = ControllerConfigAddresses & {
  recoveryTimelock: number;
};
