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

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getEthereumInkUSDCConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    // proxyAdmin: {
    //   owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    //   address: '0xdD702861AB97419858ccc85eDa4765e26D955d88',
    // },
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const ink: HypTokenRouterConfig = {
    ...routerConfig.ink,
    owner: abacusWorksEnvOwnerConfig.ink.owner,
    // proxyAdmin: {
    //   owner: abacusWorksEnvOwnerConfig.ink.owner,
    //   address: '0x4Ae15e875BDf5956D5c345A21AD83A20FD0692E6',
    // },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    ink,
  };
};
