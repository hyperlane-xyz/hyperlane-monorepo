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

export const getEclipseStrideTiaWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'BpXHAiktwjx7fN6M9ST9wr6qKAsH27wZFhdHEhReJsR6',
    gas: 300_000,
  };

  const stride: TokenRouterConfig = {
    ...routerConfig.stride,
    ...getNonAbacusWorksOwnerConfig('TODO'),
    type: TokenType.collateral,
    foreignDeployment:
      'stride1pvtesu3ve7qn7ctll2x495mrqf2ysp6fws68grvcu6f7n2ajghgsh2jdj6',
    token: 'stutia',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
