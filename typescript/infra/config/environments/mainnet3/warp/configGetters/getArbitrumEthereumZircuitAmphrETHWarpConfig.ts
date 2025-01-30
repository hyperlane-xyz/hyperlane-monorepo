import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfig,
  OwnableConfig,
  TokenType,
} from '@hyperlane-xyz/sdk';

import { getOwnerConfigForAddress } from '../../../../../src/config/environment.js';
import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

// MEV Capital
const arbitrumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const ethereumOwner = '0x008615770B588633265cB01Abd19740fAe67d0B9';
const zircuitOwner = '0xD0673e7F3FB4037CA79F53d2d311D0e017d39963';

export const getArbitrumEthereumZircuitAmphrETHWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  _abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const arbitrum: HypTokenRouterConfig = {
    ...routerConfig.arbitrum,
    owner: arbitrumOwner,
    proxyAdmin: {
      owner: arbitrumOwner,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: ethereumOwner,
    proxyAdmin: {
      owner: ethereumOwner,
    },
    type: TokenType.collateral,
    token: tokens.ethereum.amphrETH,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  const zircuit: HypTokenRouterConfig = {
    ...routerConfig.zircuit,
    owner: zircuitOwner,
    proxyAdmin: {
      owner: zircuitOwner,
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    arbitrum,
    ethereum,
    zircuit,
  };
};
