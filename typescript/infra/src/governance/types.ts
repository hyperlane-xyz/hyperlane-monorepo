import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { RouterConfig } from '@abacus-network/deploy';

export type GovernanceConfigAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = RouterConfig & {
  recoveryTimelock: number;
  addresses: Partial<Record<ChainName, GovernanceConfigAddresses>>;
};
