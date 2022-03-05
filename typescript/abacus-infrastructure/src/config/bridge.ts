import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '@abacus-network/abacus-deploy';
import { XAppCoreAddresses } from './core';

export type BridgeContractAddresses = {
  router: ProxiedAddress;
  token: ProxiedAddress;
  helper?: types.Address;
};

type BridgeAddresses = {
  weth?: types.Address;
};

export type BridgeConfig = {
  recoveryTimelock: number;
  // TODO(asa): Can we restrict to chianname?
  addresses: Record<string, BridgeAddresses>;
  core: Record<string, XAppCoreAddresses>;
};
