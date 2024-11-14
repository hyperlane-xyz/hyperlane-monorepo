import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';
import { DEPLOYER } from '../../owners.js';

// Keep on our deployer for now until we get an address from Flow
const owner = DEPLOYER;
const ownerConfig = getOwnerConfigForAddress(owner);

export const getEthereumFlowCbBTCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...ownerConfig,
    type: TokenType.collateral,
    token: tokens.ethereum.cbBTC,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const flowmainnet: TokenRouterConfig = {
    ...routerConfig.flowmainnet,
    ...ownerConfig,
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    flowmainnet,
  };
};
