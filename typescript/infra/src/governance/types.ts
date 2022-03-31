import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { RouterConfig } from '@abacus-network/deploy';

export type GovernanceAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = RouterConfig & {
  recoveryTimelock: number;
  addresses: Partial<Record<ChainName, GovernanceAddresses>>;
};

export type GovernanceConfigWithoutCore = Omit<GovernanceConfig, 'core'>;
