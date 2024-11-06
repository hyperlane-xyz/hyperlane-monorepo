import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getEclipseEthereumSolanaUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: 'D6k6T3G74ij6atCtBiWBs5TbFa1hFVcrFUSGZHuV7q3Z',
    gas: 300_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: tokens.ethereum.USDC,
  };

  // Intentionally don't enroll Solana to avoid transferring
  // directly between Solana and Ethereum

  return {
    eclipsemainnet,
    ethereum,
  };
};
