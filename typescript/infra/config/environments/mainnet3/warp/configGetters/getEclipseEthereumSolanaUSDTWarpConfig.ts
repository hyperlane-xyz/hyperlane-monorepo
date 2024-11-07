import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getEclipseEthereumSolanaUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
    gas: 300_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  // Intentionally don't enroll Solana to avoid transferring
  // directly between Solana and Ethereum

  return {
    eclipsemainnet,
    ethereum,
  };
};
