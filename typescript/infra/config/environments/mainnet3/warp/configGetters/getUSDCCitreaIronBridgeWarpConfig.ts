import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { assert, addressToBytes32 } from '@hyperlane-xyz/utils';

import { awIcas } from '../../governance/ica/aw.js';
import { awSafes } from '../../governance/safe/aw.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { getDomainId, getRegistry } from '../../../../registry.js';
import { WarpRouteIds } from '../warpIds.js';

// Iron-issued deposit addresses, one per (origin, dest) lane.
// Source: 6 prod Iron autoramps on Iron customer 019e02ea, created 2026-05-07.
const IRON_DEPOSITS: Record<
  BridgeChain,
  Partial<Record<BridgeChain, string>>
> = {
  arbitrum: { citrea: '0x8a00cab29921a978ebdb533521cf0fd2a202bd88' }, // 019e02ea-d0b9-7967-8475-3249a4990204
  base: { citrea: '0x60ec523f9771b1bb19b54bd787ca3c7aa9c88d33' }, // 019e02ec-6416-7331-bd86-f01bc4309770
  ethereum: { citrea: '0x2d5b94b7f18c7d5faa0c6bd5c360c910bee9ad6a' }, // 019e02ec-d5b3-771e-9318-c692c0047064
  polygon: { citrea: '0x78bd5a96fdeae542f9e8511e14831ddbe8df2298' }, // 019e6941-f4d3-70bc-a1d5-24ca8b7623de
  citrea: {
    arbitrum: '0x90a2e5228281c4ba87063b34bf91d986b2c8a75e', // 019e02ed-a694-753f-b848-7f40da70e5fc
    base: '0x2417e53c4a6757e0380f8686b0597ea88fac1e47', // 019e02ee-60c3-72e2-a75a-70666c6224b3
    ethereum: '0x080a35df853adf546c237b2e24b4178f03f9aa6d', // 019e02ee-f696-78fe-9d79-6165e010fa09
    polygon: '0x5b1527569edcefc2f178b995dc5e83ed5b225ee3', // 019e6941-f7cc-7170-96a4-f1e463542a34
  },
};

const ORIGIN_TOKENS: Record<BridgeChain, string> = {
  arbitrum: tokens.arbitrum.USDC,
  base: tokens.base.USDC,
  ethereum: tokens.ethereum.USDC,
  citrea: tokens.citrea.ctUSD,
  polygon: tokens.polygon.USDC,
};

const BRIDGE_CHAINS = [
  'arbitrum',
  'base',
  'ethereum',
  'citrea',
  'polygon',
] as const;
type BridgeChain = (typeof BRIDGE_CHAINS)[number];

const ownersByChain: Record<BridgeChain, string> = {
  arbitrum: awIcas.arbitrum,
  base: awIcas.base,
  citrea: awIcas.citrea,
  ethereum: awSafes.ethereum,
  polygon: awIcas.polygon,
};

// The expected symbol per chain in the USDC/moonpay route
const DESTINATION_SYMBOLS: Record<BridgeChain, string> = {
  arbitrum: 'USDC',
  base: 'USDC',
  ethereum: 'USDC',
  citrea: 'ctUSD',
  polygon: 'USDC',
};

function getMoonpayRouterAddresses(): Record<BridgeChain, string> {
  const route = getRegistry().getWarpRoute(WarpRouteIds.USDCCitreaMoonpay);
  assert(route, 'USDC/moonpay route not found in registry');

  const find = (chain: BridgeChain) => {
    const symbol = DESTINATION_SYMBOLS[chain];
    const token = route.tokens.find(
      (t) => t.chainName === chain && t.symbol === symbol,
    );
    assert(
      token?.addressOrDenom,
      `Missing Moonpay ${symbol} router for ${chain}`,
    );
    return token.addressOrDenom;
  };

  return {
    arbitrum: find('arbitrum'),
    base: find('base'),
    ethereum: find('ethereum'),
    citrea: find('citrea'),
    polygon: find('polygon'),
  };
}

function destinationConfigsFor(
  origin: BridgeChain,
  moonpayRouters: Record<BridgeChain, string>,
) {
  const lanes = IRON_DEPOSITS[origin];
  const result: Record<
    string,
    Record<string, { depositAddress: string; feeBps: string }>
  > = {};
  for (const dest of BRIDGE_CHAINS) {
    const depositAddress = lanes[dest];
    if (depositAddress === undefined) continue;
    result[String(getDomainId(dest))] = {
      [addressToBytes32(moonpayRouters[dest])]: { depositAddress, feeBps: '0' },
    };
  }
  return result;
}

export const getUSDCCitreaIronBridgeWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const moonpayRouters = getMoonpayRouterAddresses();

  return Object.fromEntries(
    BRIDGE_CHAINS.map((origin) => {
      assert(routerConfig[origin], `Missing router config for ${origin}`);
      return [
        origin,
        {
          ...routerConfig[origin],
          type: TokenType.collateralDepositAddress,
          token: ORIGIN_TOKENS[origin],
          owner: ownersByChain[origin],
          destinationConfigs: destinationConfigsFor(origin, moonpayRouters),
          // collateralDepositAddress contracts don't use remoteRouters for routing;
          // suppress auto-population so warp apply doesn't generate spurious enrollments.
          remoteRouters: {},
        },
      ];
    }),
  );
};
