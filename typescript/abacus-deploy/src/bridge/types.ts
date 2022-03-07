import { types } from '@abacus-network/utils';
import { ChainName } from '../config';
import { ProxiedAddress } from '../common';
import { RouterConfig } from '../router';

export type BridgeContractAddresses = {
  router: ProxiedAddress;
  token: ProxiedAddress;
  helper?: types.Address;
};

export type BridgeConfig = RouterConfig & {
  weth: Partial<Record<ChainName, types.Address>>;
};

export type BridgeConfigWithoutCore = Omit<BridgeConfig, 'core'>;
