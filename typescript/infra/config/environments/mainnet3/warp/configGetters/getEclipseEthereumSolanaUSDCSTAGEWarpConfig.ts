import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  RouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

const deployer = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

export const getEclipseEthereumSolanaUSDCSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: '6QSWUmEaEcE2KJrU5jq7T11tNRaVsgnG8XULezjg7JjL',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: tokens.ethereum.USDC,
    owner: deployer,
    symbol: 'USDCSTAGE',
    name: 'USD Coin STAGE',
  };

  // Intentionally don't enroll Solana to avoid transferring
  // directly between Solana and Ethereum

  return {
    eclipsemainnet,
    ethereum,
  };
};
