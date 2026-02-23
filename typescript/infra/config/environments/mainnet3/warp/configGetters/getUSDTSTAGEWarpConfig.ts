import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { zeroAddress } from 'viem';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

interface RouteConfig<T> {
  ethereum: T;
  plasma: T;
  arbitrum: T;
  mode: T;
  solanamainnet: T;
}

type RouteChains = keyof RouteConfig<any>;

const SOLANA_OWNER = '5seKh2p3B8Kq9nAE7X4svfX9uLt81wWAiDJuLK1XNgXf';

const STAGING_PROGRAM_IDS = {
  solanamainnet: '7xQYs3RZvycfk3nwDPGZhbkA9318xx324xhWDcENVfjg',
};

export async function getUSDTSTAGEWarpConfig(
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> {
  const config: RouteConfig<HypTokenRouterConfig> = {
    ethereum: {
      ...routerConfig.ethereum,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: tokens.ethereum.USDT,
      interchainSecurityModule: zeroAddress,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
    },
    plasma: {
      ...routerConfig.plasma,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
      interchainSecurityModule: zeroAddress,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
    },
    arbitrum: {
      ...routerConfig.arbitrum,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: zeroAddress,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
    },
    solanamainnet: {
      type: TokenType.collateral,
      token: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: STAGING_PROGRAM_IDS.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      owner: SOLANA_OWNER,
    },
    mode: {
      ...routerConfig.mode,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.synthetic,
      interchainSecurityModule: zeroAddress,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
    },
  };
  return config as Record<RouteChains, HypTokenRouterConfig>;
}
