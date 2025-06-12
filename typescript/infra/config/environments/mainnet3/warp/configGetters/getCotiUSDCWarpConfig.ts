import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert, objMap } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { usdcTokenAddresses } from '../cctp.js';
import { WarpRouteIds } from '../warpIds.js';

const SYNTHETIC_CHAIN = 'coti';

const REBALANCER = '0xa3948a15e1d0778a7d53268b651B2411AF198FE3';

const owners = {
  ethereum: '0x490056F682A417C04c08DE1be0C96965182BBa20',
  coti: '0xdF2E2886d23ba57F996C203D2Ccd9dCa6373590C',
  // TODO: add safes
  arbitrum: '',
  base: '',
  optimism: '',
} as const;

export const getCotiUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const registry = getRegistry();
  const mainnetCCTP = registry.getWarpRoute(WarpRouteIds.MainnetCCTP);

  assert(mainnetCCTP, 'MainnetCCTP warp route not found');

  const cctpBridges = Object.fromEntries(
    mainnetCCTP.tokens.map(({ chainName, addressOrDenom }) => [
      chainName,
      addressOrDenom!,
    ]),
  );

  return objMap(owners, (chain, owner): HypTokenRouterConfig => {
    if (chain === SYNTHETIC_CHAIN) {
      return {
        ...routerConfig[chain],
        type: TokenType.synthetic,
        owner,
      };
    }

    const cctpBridge = cctpBridges[chain];
    const remotes = Object.keys(owners).filter((c) => c !== chain);

    const allowedRebalancingBridges = Object.fromEntries(
      remotes.map((remote) => [remote, [{ bridge: cctpBridge }]]),
    );

    const config: HypTokenRouterConfig = {
      ...routerConfig[chain],
      type: TokenType.collateral,
      token: usdcTokenAddresses[chain],
      owner,
      allowedRebalancers: [REBALANCER],
      allowedRebalancingBridges,
    };

    return config;
  });
};
