import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

export const getTRUMPWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const tokenConfig: ChainMap<HypTokenRouterConfig> = {
    solanamainnet: {
      ...routerConfig.solanamainnet,
      type: TokenType.collateral,
      isNft: false,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 6,
      totalSupply: 0,
      token: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN',
      owner: '0xa7ECcdb9Be08178f896c26b7BbD8C3D4E844d9Ba',
      gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
      foreignDeployment: '21tAY4poz2VXvghqdSQpn9j7gYravQmGpuQi8pHPx9DS',
    },
    base: {
      ...routerConfig.base,
      type: TokenType.synthetic,
      isNft: false,
      name: 'OFFICIAL TRUMP',
      symbol: 'TRUMP',
      decimals: 18,
      totalSupply: 0,
      owner: abacusWorksEnvOwnerConfig.base.owner,
      proxyAdmin: {
        owner: abacusWorksEnvOwnerConfig.base.owner,
        address: '0xBaE44c2D667C73e2144d938d6cC87901A6fd1c00',
      },
    },
  };

  return tokenConfig;
};
