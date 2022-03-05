import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '@abacus-network/abacus-deploy';
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
  // TODO(asa): Can we restrict to chianname?
  addresses: Record<string, GovernanceAddresses>;
};

export type GovernanceConfigWithoutCore = Omit<GovernanceConfig, 'core'>;
