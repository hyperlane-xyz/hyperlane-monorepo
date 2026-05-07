import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';
const BRIDGE_OWNER = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';

const BRIDGE_CHAINS = ['arbitrum', 'base', 'ethereum', 'citrea'] as const;
type BridgeChain = (typeof BRIDGE_CHAINS)[number];

const ORIGIN_TOKENS: Record<BridgeChain, string> = {
  arbitrum: tokens.arbitrum.USDC,
  base: tokens.base.USDC,
  ethereum: tokens.ethereum.USDC,
  citrea: tokens.citrea.ctUSD,
};

const EVM_CHAINS: BridgeChain[] = ['arbitrum', 'base', 'ethereum'];

function getTBDAAddresses(): Record<BridgeChain, string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaIronBridge);
  assert(route, 'CROSS/ctusd-ironbridge route not found in registry');

  const find = (chain: BridgeChain) => {
    const token = route.tokens.find((t) => t.chainName === chain);
    assert(token?.addressOrDenom, `Missing TBDA address for ${chain}`);
    return token.addressOrDenom;
  };

  return {
    arbitrum: find('arbitrum'),
    base: find('base'),
    ethereum: find('ethereum'),
    citrea: find('citrea'),
  };
}

export const getUSDCCitreaMoonpayWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const tbda = getTBDAAddresses();

  return Object.fromEntries(
    BRIDGE_CHAINS.map((chain) => {
      assert(routerConfig[chain], `Missing router config for ${chain}`);

      const token = ORIGIN_TOKENS[chain];

      const allowedRebalancingBridges =
        chain === 'citrea'
          ? Object.fromEntries(
              EVM_CHAINS.map((dest) => [
                dest,
                [{ bridge: tbda.citrea, approvedTokens: [token] }],
              ]),
            )
          : { citrea: [{ bridge: tbda[chain], approvedTokens: [token] }] };

      return [
        chain,
        {
          ...routerConfig[chain],
          type: TokenType.crossCollateral,
          token,
          owner: BRIDGE_OWNER,
          allowedRebalancers: [REBALANCER],
          allowedRebalancingBridges,
        },
      ];
    }),
  );
};
