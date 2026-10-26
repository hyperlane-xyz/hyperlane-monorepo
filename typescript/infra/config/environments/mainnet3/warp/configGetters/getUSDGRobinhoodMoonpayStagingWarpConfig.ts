import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';
import {
  getMoonpayStagingRebalancers,
  getMoonpayStagingUsdcPeers,
} from './moonpayStaging.js';

export async function getUSDGRobinhoodMoonpayStagingWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return {
    robinhood: {
      type: TokenType.crossCollateral,
      token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      mailbox: routerConfig.robinhood.mailbox,
      owner: DEPLOYER,
      allowedRebalancers: getMoonpayStagingRebalancers(),
      // Inventory only: no direct MCR bridge, no USDT peers, zero warp fee.
      allowedRebalancingBridges: {},
      crossCollateralRouters: getMoonpayStagingUsdcPeers(),
    },
  };
}
