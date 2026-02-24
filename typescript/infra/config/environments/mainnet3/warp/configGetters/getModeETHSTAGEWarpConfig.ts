import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

const STAGING_TOKEN_METADATA = {
  symbol: 'ETHSTAGE',
  name: 'Ether STAGE',
  decimals: 18,
};

const nativeChains = ['arbitrum', 'base', 'ethereum', 'optimism'] as const;
const syntheticChains = ['mode'] as const;

type NativeChain = (typeof nativeChains)[number];
type SyntheticChain = (typeof syntheticChains)[number];

// Deployer EOA for staging testing
const DEPLOYER_EOA: Address = '0x3e0A78A330F2b97059A4D507ca9d8292b65B6FB5';

export const getModeETHSTAGEWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  // Native ETH chains (collateral)
  const nativeConfig = (chain: NativeChain): HypTokenRouterConfig => ({
    ...routerConfig[chain],
    owner: DEPLOYER_EOA,
    type: TokenType.native,
    ...STAGING_TOKEN_METADATA,
  });

  // Synthetic chain (mode)
  const syntheticConfig = (chain: SyntheticChain): HypTokenRouterConfig => ({
    ...routerConfig[chain],
    owner: DEPLOYER_EOA,
    type: TokenType.synthetic,
    ...STAGING_TOKEN_METADATA,
  });

  return {
    arbitrum: nativeConfig('arbitrum'),
    base: nativeConfig('base'),
    ethereum: nativeConfig('ethereum'),
    optimism: nativeConfig('optimism'),
    mode: syntheticConfig('mode'),
  };
};
