import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { DEPLOYER } from '../../owners.js';

export const getEthereumEclipseTETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'BJa3fPvvjKx8gRCWunoSrWBbsmieub37gsGpjp4BfTfW',
    gas: 300_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: '0x3Ac6A6Cca0b49C3f3f06D12F46e8d88EEfbB7415',
    owner: DEPLOYER,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
