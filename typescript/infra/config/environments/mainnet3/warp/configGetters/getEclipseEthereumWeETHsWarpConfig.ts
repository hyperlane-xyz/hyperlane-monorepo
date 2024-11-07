import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

export const getEclipseEthereumWeEthsWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const eclipsemainnet: TokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: '7Zx4wU1QAw98MfvnPFqRh1oyumek7G5VAX6TKB3U1tcn',
    gas: 300_000,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.weETHs,
    interchainSecurityModule: ethers.constants.AddressZero,
    owner: DEPLOYER,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
