import { RouterConfig } from '@abacus-network/deploy';
import { ChainName, ChainSubsetMap } from '@abacus-network/sdk';
import { types } from '@abacus-network/utils';

export type GovernanceConfigAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig<Networks extends ChainName> =
  RouterConfig<Networks> & {
    recoveryTimelock: number;
    addresses: ChainSubsetMap<Networks, GovernanceConfigAddresses>;
  };
