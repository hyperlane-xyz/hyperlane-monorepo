import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getEclipseStrideStTiaWarpConfig = async (
  _routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'tKUHyJ5NxhnwU94JUmzh1ekukDcHHX8mZF6fqxbMwX6',
    gas: 300_000,
  };

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const stride: TokenRouterConfig = {
    type: TokenType.collateral,
    foreignDeployment:
      'stride134axwdlam929m3mar3wv95nvkyep7mr87ravkqcpf8dfe3v0pjlqwrw6ee',
  };

  return {
    eclipsemainnet,
    stride,
  };
};
