import { ethers } from 'ethers';

import {
  ChainMap,
  OwnableConfig,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import {
  RouterConfigWithoutOwner,
  tokens,
} from '../../../../../src/config/warp.js';

export const getAncient8EthereumUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
  abacusWorksEnvOwnerConfig: ChainMap<OwnableConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['ancient8'],
    defaultMultisigConfigs,
  ).ancient8;

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    ...abacusWorksEnvOwnerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ismConfig,
    // This hook was recovered from running the deploy script
    // for the hook module. The hook configuration is the Ethereum
    // default hook for the Ancient8 remote (no routing).
    hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
  };

  const ancient8: TokenRouterConfig = {
    ...routerConfig.ancient8,
    ...abacusWorksEnvOwnerConfig.ancient8,
    type: TokenType.synthetic,
    // Uses the default ISM
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    ancient8,
  };
};
