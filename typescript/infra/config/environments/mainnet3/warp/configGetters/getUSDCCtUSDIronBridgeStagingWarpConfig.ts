import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// Owner of every TokenBridgeDepositAddress instance. Controls only
// add/removeDestinationConfig; intentionally distinct from the cross-collateral
// router's MCR rebalancer so a deployer-key compromise can't redirect Iron
// deposits without also moving funds via the MCR.
const BRIDGE_OWNER = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

// CROSS/ctusd cross-collateral routers (the Iron autoramp receivers).
const CTUSD_ROUTERS = {
  arbitrum: '0x62fe676dff1e7ABBCcbedc8BABc993827b9fb189',
  base: '0xd54A15f8dF8C6dD9Ef3b5589BE0bF37EC6f61F91',
  ethereum: '0xd4463cB3c90b3F49c673310BEC9bC18311134B47',
  citrea: '0x38E8720EBE02e7c5254F9De9F81440C7a770a9c6',
} as const;

type CtUSDChain = keyof typeof CTUSD_ROUTERS;

// Iron-issued deposit addresses, one per (origin, dest) lane. Source: the 6
// "Staging MovableCollateral Market" autoramps on Iron customer
// 019d44d2-fc8e-74d2-8f92-1a69cf4e10a7 created 2026-05-01, verified via
// GET https://api.iron.xyz/api/autoramps.
const IRON_DEPOSITS: Record<CtUSDChain, Partial<Record<CtUSDChain, string>>> = {
  arbitrum: { citrea: '0xe11a54ad85e4f04962c93f26d2c746f610a61933' }, // 019de402-b49e
  base: { citrea: '0x99dcac2e06090fc843feb0f36516ac7e0b351fcf' }, // 019de402-4cfc
  ethereum: { citrea: '0xba16a57c15c95fd89f096e7c9bb98d1fe25583b3' }, // 019de401-c8b5
  citrea: {
    arbitrum: '0x1e9ad719e6dd6c86370d7a0f99430e86fe0f1039', // 019de409-00d7
    base: '0xdb99b7f572d22429fc9dbde5a32c3f159eb17e30', // 019de40a-695f
    ethereum: '0x33d51a880f83df9b9560d826e0a6de022d285da1', // 019de404-39a7
  },
};

const ORIGIN_TOKENS: Record<CtUSDChain, string> = {
  arbitrum: tokens.arbitrum.USDC,
  base: tokens.base.USDC,
  ethereum: tokens.ethereum.USDC,
  citrea: tokens.citrea.ctUSD,
};

function destinationConfigsFor(origin: CtUSDChain) {
  const lanes = IRON_DEPOSITS[origin];
  return Object.fromEntries(
    Object.entries(lanes).map(([dest, depositAddress]) => [
      dest,
      {
        [addressToBytes32(CTUSD_ROUTERS[dest as CtUSDChain])]: {
          depositAddress,
          feeBps: '0',
        },
      },
    ]),
  );
}

export const getUSDCCtUSDIronBridgeStagingWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const origins: readonly CtUSDChain[] = [
    'arbitrum',
    'base',
    'ethereum',
    'citrea',
  ];

  return Object.fromEntries(
    origins.map((origin) => [
      origin,
      {
        ...routerConfig[origin],
        type: TokenType.collateralDepositAddress,
        token: ORIGIN_TOKENS[origin],
        owner: BRIDGE_OWNER,
        destinationConfigs: destinationConfigsFor(origin),
      },
    ]),
  );
};
