import { CONTRACTS_PACKAGE_VERSION } from '@hyperlane-xyz/core';
import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { ethers } from 'ethers';

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
  bsc: T;
  tron: T;
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
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
    plasma: {
      ...routerConfig.plasma,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: '0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb',
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
    arbitrum: {
      ...routerConfig.arbitrum,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: tokens.arbitrum.USDT,
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
    solanamainnet: {
      type: TokenType.collateral,
      token: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      mailbox: routerConfig.solanamainnet.mailbox,
      foreignDeployment: STAGING_PROGRAM_IDS.solanamainnet,
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      owner: SOLANA_OWNER,
      decimals: 6,
      hook: 'AkeHBbE5JkwVppujCQQ6WuxsVsJtruBAjUo6fDCFp6fF',
    },
    mode: {
      ...routerConfig.mode,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.synthetic,
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
    bsc: {
      ...routerConfig.bsc,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: tokens.bsc.USDT,
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 18,
      scale: {
        numerator: 1,
        denominator: 1000000000000, // scale DOWN: 18-decimal BSC to 6-decimal message encoding
      },
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
    tron: {
      ...routerConfig.tron,
      owner: '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5',
      type: TokenType.collateral,
      token: tokens.tron.USDT,
      interchainSecurityModule: ethers.constants.AddressZero,
      name: 'Tether USD STAGE',
      symbol: 'USDTSTAGE',
      decimals: 6,
      contractVersion: CONTRACTS_PACKAGE_VERSION,
    },
  };
  return config as Record<RouteChains, HypTokenRouterConfig>;
}
