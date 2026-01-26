import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { awSafes } from '../../governance/safe/aw.js';
import { chainOwners } from '../../owners.js';
import { SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT } from '../consts.js';

import {
  awProxyAdminAddresses,
  awProxyAdminOwners,
} from './getEclipseUSDCWarpConfig.js';

const CONTRACT_VERSION = '10.1.3';

export const getEclipseEthereumSolanaUSDTWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const eclipsemainnet: HypTokenRouterConfig = {
    ...routerConfig.eclipsemainnet,
    ...abacusWorksEnvOwnerConfig.eclipsemainnet,
    type: TokenType.synthetic,
    foreignDeployment: '5g5ujyYUNvdydwyDVCpZwPpgYRqH5RYJRi156cxyE3me',
    gas: SEALEVEL_WARP_ROUTE_HANDLER_GAS_AMOUNT,
    interchainSecurityModule: ethers.constants.AddressZero,
  };
  const ethereum: HypTokenRouterConfig = {
    mailbox: routerConfig.ethereum.mailbox,
    owner: awSafes.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDT,
    contractVersion: CONTRACT_VERSION,
    proxyAdmin: {
      owner: awProxyAdminOwners.ethereum ?? chainOwners.ethereum.owner,
      address: awProxyAdminAddresses.ethereum,
    },
  };

  // Intentionally don't enroll Solana to avoid transferring
  // directly between Solana and Ethereum

  return {
    eclipsemainnet,
    ethereum,
  };
};
