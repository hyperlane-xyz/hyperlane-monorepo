import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '@abacus-network/abacus-deploy';
import { XAppCoreAddresses } from '../config/core';

export type BridgeContractAddresses = {
  router: ProxiedAddress;
  token: ProxiedAddress;
  helper?: types.Address;
};

export type BridgeAddresses = {
  weth: types.Address;
};

export type BridgeConfig = {
  // TODO(asa): Can we restrict to chianname?
  addresses: Record<string, BridgeAddresses>;
  core: Record<string, XAppCoreAddresses>;
};

export type BridgeConfigWithoutCore = Omit<BridgeConfig, 'core'>;
