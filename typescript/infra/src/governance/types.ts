import { RouterConfig } from '@abacus-network/deploy';
import { types } from '@abacus-network/utils';

export type GovernanceConfigAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = RouterConfig &
  GovernanceConfigAddresses & { recoveryTimelock: number };
