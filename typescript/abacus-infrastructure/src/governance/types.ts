import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '@abacus-network/abacus-deploy';
import { XAppCoreAddresses } from '../config/core';

export type GovernanceContractAddresses = {
  router: ProxiedAddress;
};

export type GovernanceAddresses = {
  recoveryManager: types.Address;
  governor?: types.Address;
};

export type GovernanceConfig = {
  recoveryTimelock: number;
  // TODO(asa): Can we restrict to chianname?
  addresses: Record<string, GovernanceAddresses>;
  core: Record<string, XAppCoreAddresses>;
};

export type GovernanceConfigWithoutCore = Omit<GovernanceConfig, 'core'>;
