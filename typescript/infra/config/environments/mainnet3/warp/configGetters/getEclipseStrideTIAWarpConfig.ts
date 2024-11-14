import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  getNonAbacusWorksOwnerConfig,
} from '../../../../../src/config/warp.js';

export const getEclipseStrideStTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'tKUHyJ5NxhnwU94JUmzh1ekukDcHHX8mZF6fqxbMwX6',
    gas: 300_000,
  };

  const stride: TokenRouterConfig = {
    ...routerConfig.stride,
    ...getNonAbacusWorksOwnerConfig('TODO'),
    type: TokenType.collateral,
    foreignDeployment:
      'stride134axwdlam929m3mar3wv95nvkyep7mr87ravkqcpf8dfe3v0pjlqwrw6ee',
    token:
      'ibc/BF3B4F53F3694B66E13C23107C84B6485BD2B96296BB7EC680EA77BBA75B4801',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
