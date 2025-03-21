import { ChainMap, HypTokenRouterConfig } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

import { getBaseEthereumSuperseedCBBTCWarpConfig } from './getBaseEthereumSuperseedCBBTCWarpConfig.js';

export const getEthereumSuperseedCBBTCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const { ethereum, superseed } = await getBaseEthereumSuperseedCBBTCWarpConfig(
    routerConfig,
  );

  return {
    ethereum,
    superseed,
  };
};
