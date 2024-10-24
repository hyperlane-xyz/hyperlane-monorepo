import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getStrideEclipseTiaWarpConfig = async (
  _routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'BpXHAiktwjx7fN6M9ST9wr6qKAsH27wZFhdHEhReJsR6',
    gas: 300_000,
  };

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const stride: TokenRouterConfig = {
    type: TokenType.collateral,
    foreignDeployment:
      'stride1pvtesu3ve7qn7ctll2x495mrqf2ysp6fws68grvcu6f7n2ajghgsh2jdj6',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
