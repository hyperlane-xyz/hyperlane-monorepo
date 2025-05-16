import { ethers } from 'ethers';

import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

const owners = {
  ethereum: '0x9b948CC7CfC4B67262CbbcC37f9d09B61ea6f0E3',
  bsc: '0xA788b57518bBE602ac94CCEE5ae7E4831a546Bfd',
  lumiaprism: '0x1C4A50f3E9Bfeb268448D19d0D3fe6d58CB0f7BE',
};

const ISM_CONFIG = ethers.constants.AddressZero; // Default ISM

export const getBscEthereumLumiaPrismPNDRWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  const ethereum: HypTokenRouterConfig = {
    ...routerConfig.ethereum,
    owner: owners.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.PNDR,
    interchainSecurityModule: ISM_CONFIG,
  };

  const bsc: HypTokenRouterConfig = {
    ...routerConfig.bsc,
    owner: owners.bsc,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  const lumiaprism: HypTokenRouterConfig = {
    ...routerConfig.lumiaprism,
    owner: owners.lumiaprism,
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    bsc,
    lumiaprism,
  };
};
