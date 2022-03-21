import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { RouterConfig } from '../router';

export type BridgeConfig = RouterConfig & {
  weth: Partial<Record<ChainName, types.Address>>;
};

export type BridgeConfigWithoutCore = Omit<BridgeConfig, 'core'>;
