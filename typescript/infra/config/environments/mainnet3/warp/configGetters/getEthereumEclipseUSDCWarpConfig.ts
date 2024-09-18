import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { DEPLOYER } from '../../owners.js';

export const getEthereumEclipseUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'D6k6T3G74ij6atCtBiWBs5TbFa1hFVcrFUSGZHuV7q3Z',
    gas: 300_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: '0xFc8F5272d690cf19732a7eD6f246aDF5fB8708dB',
    owner: DEPLOYER,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
