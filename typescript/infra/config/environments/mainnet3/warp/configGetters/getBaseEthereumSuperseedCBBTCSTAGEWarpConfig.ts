import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import { getBaseEthereumSuperseedCBBTCWarpConfig } from './getBaseEthereumSuperseedCBBTCWarpConfig.js';

export const getBaseEthereumSuperseedCBBTCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { base, ethereum, superseed } =
    await getBaseEthereumSuperseedCBBTCWarpConfig(routerConfig);

  return {
    base,
    ethereum,
    superseed,
  };
};
