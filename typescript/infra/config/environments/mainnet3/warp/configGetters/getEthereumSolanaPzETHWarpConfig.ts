import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { ethers } from 'ethers';
import { DEPLOYER } from '../../owners.js';

export const getEthereumSolanaPzETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const solana: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: 'GiP8GwN1GsscVJvmKSD4muDEihRzZRa9mxnS1Toi64pa',
    gas: 300_000,
  };

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    interchainSecurityModule: ethers.constants.AddressZero,
    token: '0x8c9532a60e0e7c6bbd2b2c1303f63ace1c3e9811',
    owner: DEPLOYER,
  };

  return {
    solana,
    ethereum,
  };
};
