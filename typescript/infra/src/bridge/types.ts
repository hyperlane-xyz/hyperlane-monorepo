import { types } from '@abacus-network/utils';
import { ChainName } from '@abacus-network/sdk';
import { RouterConfig } from '@abacus-network/deploy';

export type BridgeConfig = RouterConfig & {
  weth: Partial<Record<ChainName, types.Address>>;
};

export type BridgeConfigWithoutCore = Omit<BridgeConfig, 'core'>;
