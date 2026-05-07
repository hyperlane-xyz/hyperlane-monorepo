import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert, addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

// Owner of every TokenBridgeDepositAddress instance. Controls only
// add/removeDestinationConfig; intentionally distinct from the cross-collateral
// router's MCR rebalancer so a deployer-key compromise can't redirect Iron
// deposits without also moving funds via the MCR.
const BRIDGE_OWNER = '0x1cFd6A81e98de59e3eeB3AE35c3cb13FCb586E1E';

// Iron-issued deposit addresses, one per (origin, dest) lane.
// Source: 6 prod Iron autoramps on Iron customer 019e02ea, created 2026-05-07.
const IRON_DEPOSITS: Record<
  BridgeChain,
  Partial<Record<BridgeChain, string>>
> = {
  arbitrum: { citrea: '0x8a00cab29921a978ebdb533521cf0fd2a202bd88' }, // 019e02ea-d0b9-7967-8475-3249a4990204
  base: { citrea: '0x60ec523f9771b1bb19b54bd787ca3c7aa9c88d33' }, // 019e02ec-6416-7331-bd86-f01bc4309770
  ethereum: { citrea: '0x2d5b94b7f18c7d5faa0c6bd5c360c910bee9ad6a' }, // 019e02ec-d5b3-771e-9318-c692c0047064
  citrea: {
    arbitrum: '0x90a2e5228281c4ba87063b34bf91d986b2c8a75e', // 019e02ed-a694-753f-b848-7f40da70e5fc
    base: '0x2417e53c4a6757e0380f8686b0597ea88fac1e47', // 019e02ee-60c3-72e2-a75a-70666c6224b3
    ethereum: '0x080a35df853adf546c237b2e24b4178f03f9aa6d', // 019e02ee-f696-78fe-9d79-6165e010fa09
  },
};

const ORIGIN_TOKENS: Record<BridgeChain, string> = {
  arbitrum: tokens.arbitrum.USDC,
  base: tokens.base.USDC,
  ethereum: tokens.ethereum.USDC,
  citrea: tokens.citrea.ctUSD,
};

const BRIDGE_CHAINS = ['arbitrum', 'base', 'ethereum', 'citrea'] as const;
type BridgeChain = (typeof BRIDGE_CHAINS)[number];

// The expected symbol per chain in the CROSS/moonpay route
const DESTINATION_SYMBOLS: Record<BridgeChain, string> = {
  arbitrum: 'USDC',
  base: 'USDC',
  ethereum: 'USDC',
  citrea: 'ctUSD',
};

function getMoonpayRouterAddresses(): Record<BridgeChain, string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.CrossMoonpay);
  assert(route, 'CROSS/moonpay route not found in registry');

  return Object.fromEntries(
    BRIDGE_CHAINS.map((chain) => {
      const expectedSymbol = DESTINATION_SYMBOLS[chain];
      const token = route.tokens.find(
        ({ chainName, symbol }) =>
          chainName === chain && symbol === expectedSymbol,
      );
      assert(
        token?.addressOrDenom,
        `Missing Moonpay ${expectedSymbol} router address for ${chain}`,
      );
      return [chain, token.addressOrDenom];
    }),
  ) as Record<BridgeChain, string>;
}

function destinationConfigsFor(
  origin: BridgeChain,
  moonpayRouters: Record<BridgeChain, string>,
) {
  const lanes = IRON_DEPOSITS[origin];
  return Object.fromEntries(
    Object.entries(lanes).map(([dest, depositAddress]) => [
      dest,
      {
        [addressToBytes32(moonpayRouters[dest as BridgeChain])]: {
          depositAddress,
          feeBps: '0',
        },
      },
    ]),
  );
}

export const getUSDCCtUSDIronBridgeWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const moonpayRouters = getMoonpayRouterAddresses();

  return Object.fromEntries(
    BRIDGE_CHAINS.map((origin) => [
      origin,
      {
        ...routerConfig[origin],
        type: TokenType.collateralDepositAddress,
        token: ORIGIN_TOKENS[origin],
        owner: BRIDGE_OWNER,
        destinationConfigs: destinationConfigsFor(origin, moonpayRouters),
      },
    ]),
  );
};
