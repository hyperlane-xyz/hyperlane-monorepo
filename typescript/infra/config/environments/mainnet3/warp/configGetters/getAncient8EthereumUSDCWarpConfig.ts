import { ethers } from 'ethers';

import {
  ChainMap,
  RouterConfig,
  TokenRouterConfig,
  TokenType,
  buildAggregationIsmConfigs,
  defaultMultisigConfigs,
} from '@hyperlane-xyz/sdk';

import { tokens } from '../../../../../src/config/warp.js';

export const getAncient8EthereumUSDCWarpConfig = async (
  routerConfig: ChainMap<RouterConfig>,
): Promise<ChainMap<TokenRouterConfig>> => {
  const ismConfig = buildAggregationIsmConfigs(
    'ethereum',
    ['ancient8'],
    defaultMultisigConfigs,
  ).ancient8;

  const ethereum: TokenRouterConfig = {
    ...routerConfig.ethereum,
    type: TokenType.collateral,
    token: tokens.ethereum.USDC,
    interchainSecurityModule: ismConfig,
    // This hook was recovered from running the deploy script
    // for the hook module. The hook configuration is the Ethereum
    // default hook for the Ancient8 remote (no routing).
    hook: '0x19b2cF952b70b217c90FC408714Fbc1acD29A6A8',
  };

  // @ts-ignore - The types as they stand require a synthetic to specify
  // TokenMetadata, but in practice these are actually inferred from a
  // collateral config. To avoid needing to specify the TokenMetadata, just
  // ts-ignore for synthetic tokens.
  const ancient8: TokenRouterConfig = {
    ...routerConfig.ancient8,
    type: TokenType.synthetic,
    // Uses the default ISM
    interchainSecurityModule: ethers.constants.AddressZero,
  };

  return {
    ethereum,
    ancient8,
  };
};
