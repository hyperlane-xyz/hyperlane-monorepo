import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

import { productionDefaultRateLimitPerSecond } from './getoUSDTTokenWarpConfig.js';

const xERC20Addresses = {
  ethereum: '0x79BbE12dAa6Dd768Cd8207130a43bbA52c4f7B45', // XERC20Lockbox
  celo: '0x307e0c30FD1e65211fC727d521c98F0206b14D95', // XERC20
  worldchain: '0x307e0c30FD1e65211fC727d521c98F0206b14D95', // XERC20
};

const oXAUTRateLimitByChain: ChainMap<string> = {
  ethereum: productionDefaultRateLimitPerSecond,
  celo: productionDefaultRateLimitPerSecond,
  worldchain: productionDefaultRateLimitPerSecond,
};

export const getoXAUTTokenWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const celo: HypTokenRouterConfig = {
    ...routerConfig.celo,
    owner: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
    type: TokenType.XERC20,
    token: xERC20Addresses.celo,
    xERC20: {
      warpRouteLimits: {
        rateLimitPerSecond: oXAUTRateLimitByChain.celo,
      },
    },
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
    type: TokenType.XERC20Lockbox,
    token: xERC20Addresses.ethereum,
    xERC20: {
      warpRouteLimits: {
        rateLimitPerSecond: oXAUTRateLimitByChain.ethereum,
      },
    },
  };

  const worldchain: HypTokenRouterConfig = {
    ...routerConfig.worldchain,
    owner: '0xa7eccdb9be08178f896c26b7bbd8c3d4e844d9ba',
    type: TokenType.XERC20,
    token: xERC20Addresses.worldchain,
    xERC20: {
      warpRouteLimits: {
        rateLimitPerSecond: oXAUTRateLimitByChain.worldchain,
      },
    },
  };

  return {
    ethereum,
    celo,
    worldchain,
  };
};
