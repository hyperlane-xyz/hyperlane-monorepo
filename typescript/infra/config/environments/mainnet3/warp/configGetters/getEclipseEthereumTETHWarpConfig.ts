import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

export const getEthereumEclipseTETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'BJa3fPvvjKx8gRCWunoSrWBbsmieub37gsGpjp4BfTfW',
    gas: 300_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: '0x19e099B7aEd41FA52718D780dDA74678113C0b32',
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
