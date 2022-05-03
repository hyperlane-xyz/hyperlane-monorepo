import { RouterConfig } from '@abacus-network/deploy';
import { ChainName } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type GovernanceConfigAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = RouterConfig & {
  recoveryTimelock: number;
  addresses: Partial<Record<ChainName, GovernanceConfigAddresses>>;
};
