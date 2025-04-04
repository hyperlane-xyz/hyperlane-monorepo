import { ethers } from 'ethers';

import {
  ChainMap,
  HypTokenRouterConfigMailboxOptional,
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
): Promise<ChainMap<HypTokenRouterConfigMailboxOptional>> => {
  const ethereum: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.ethereum,
    owner: abacusWorksEnvOwnerConfig.ethereum.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.ethereum.owner,
      address: '0xd702dCed4DDeC529Ea763ddeBD8fb180C4D1843F',
    },
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ISM_CONFIG,
  };

  const ink: HypTokenRouterConfigMailboxOptional = {
    ...routerConfig.ink,
    owner: abacusWorksEnvOwnerConfig.ink.owner,
    proxyAdmin: {
      owner: abacusWorksEnvOwnerConfig.ink.owner,
      address: '0xd9Cc2e652A162bb93173d1c44d46cd2c0bbDA59D',
    },
    type: TokenType.synthetic,
    interchainSecurityModule: ISM_CONFIG,
  };

  return {
    ethereum,
    ink,
  };
};
