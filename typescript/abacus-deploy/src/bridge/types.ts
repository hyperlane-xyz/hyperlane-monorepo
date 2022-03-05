import { types } from '@abacus-network/utils';
import { ProxiedAddress } from '@abacus-network/abacus-deploy';
import { RouterConfig } from '../router';

export type BridgeContractAddresses = {
  router: ProxiedAddress;
  token: ProxiedAddress;
  helper?: types.Address;
};

export type BridgeAddresses = {
  weth: types.Address;
};

export type BridgeConfig = RouterConfig & {
  // TODO(asa): Can we restrict to chianname?
  addresses: Record<string, BridgeAddresses>;
};

export type BridgeConfigWithoutCore = Omit<BridgeConfig, 'core'>;
