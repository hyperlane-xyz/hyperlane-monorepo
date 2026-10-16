import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { awIcas } from '../../governance/ica/aw.js';
import { WARP_FEES_TURNKEY_OWNER } from '../../governance/utils.js';
import { WarpRouteIds } from '../warpIds.js';
import {
  buildCrossCollateralRoutingFee,
  getMoonpayCrossCollateralRouters,
  MOONPAY_ROUTE_CHAINS,
  getMoonpayUsdgRouter,
} from './moonpay.js';
import { REBALANCER } from './utils.js';

export async function getUSDGRobinhoodMoonpayWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  return {
    robinhood: {
      type: TokenType.crossCollateral,
      token: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
      mailbox: routerConfig.robinhood.mailbox,
      owner: awIcas.robinhood,
      allowedRebalancers: [REBALANCER],
      tokenFee: buildCrossCollateralRoutingFee(
        WARP_FEES_TURNKEY_OWNER,
        MOONPAY_ROUTE_CHAINS.filter((chain) => chain !== 'robinhood'),
      ),
      crossCollateralRouters: getMoonpayUsdgRouter()
        ? getMoonpayCrossCollateralRouters(
            [WarpRouteIds.USDCCitreaMoonpay, WarpRouteIds.USDTCitreaMoonpay],
            false,
          )
        : {},
    },
  };
}
