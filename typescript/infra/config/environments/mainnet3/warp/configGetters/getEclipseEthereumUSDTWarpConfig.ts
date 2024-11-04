import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';
import { getRegistry as getMainnet3Registry } from '../../chains.js';

export const getEclipseEthereumUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const registry = await getMainnet3Registry();

  // @ts-ignore - foreignDeployment configs don't conform to the TokenRouterConfig
  const eclipsemainnet: TokenRouterConfig = {
    type: TokenType.synthetic,
    foreignDeployment: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
    gas: 300_000,
    mailbox: (await registry.getChainAddresses('eclipsemainnet'))!.mailbox,
    owner: '9bRSUPjfS3xS6n5EfkJzHFTRDa4AHLda8BU2pP4HoWnf',
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  let ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    eclipsemainnet,
    ethereum,
  };
};
