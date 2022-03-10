import { types } from '@abacus-network/utils';
import { ChainName } from '../config';
import { ProxiedAddress } from '../common';
import { RouterConfig } from '../router';

export type GovernanceContractAddresses = {
  router: ProxiedAddress;
};

export type GovernanceAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = RouterConfig & {
  recoveryTimelock: number;
  addresses: Partial<Record<ChainName, GovernanceAddresses>>;
};

export type GovernanceConfigWithoutCore = Omit<GovernanceConfig, 'core'>;
