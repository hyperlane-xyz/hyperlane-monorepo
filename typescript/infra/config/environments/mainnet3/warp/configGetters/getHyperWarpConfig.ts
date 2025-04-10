import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const COLLATERAL_CHAIN = 'ethereum';

const TOKEN_CONFIG = {
  name: 'Hyperlane',
  symbol: 'HYPER',
  decimals: 18,
};

// 1 billion * 1e18
const INITIAL_SUPPLY = (
  1_000_000_000n *
  10n ** BigInt(TOKEN_CONFIG.decimals)
).toString();

const TOKEN_CHAINS = [
  COLLATERAL_CHAIN,
  'base',
  'optimism',
  'arbitrum',
] as const;

const STAKED_TOKEN_CONFIG = {
  name: 'Staked HYPER',
  symbol: 'stHYPER',
  decimals: TOKEN_CONFIG.decimals,
};

const STAKED_TOKEN_CHAINS = [COLLATERAL_CHAIN, 'bsc'] as const;

export const OWNERS = {
  //TODO: configure deployed AccessManager
  ethereum: '',
  // get-owner-ica output
  arbitrum: '',
  optimism: '',
  base: '',
  bsc: '',
};

export const COMPOUND_STAKING_REWARDS = '';

export const getHyperWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    TOKEN_CHAINS.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        ...TOKEN_CONFIG,
        owner: OWNERS[chain],
        type:
          chain === COLLATERAL_CHAIN
            ? TokenType.hyperToken
            : TokenType.synthetic,
        initialSupply: chain === COLLATERAL_CHAIN ? INITIAL_SUPPLY : 0,
      },
    ]),
  );
};

export const getStakedHyperWarpConfig = async (
  routerConfig: ChainMap<RouterConfigWithoutOwner>,
): Promise<ChainMap<HypTokenRouterConfig>> => {
  return Object.fromEntries(
    STAKED_TOKEN_CHAINS.map((chain) => [
      chain,
      {
        ...routerConfig[chain],
        ...STAKED_TOKEN_CONFIG,
        owner: OWNERS[chain],
        type:
          chain === COLLATERAL_CHAIN
            ? TokenType.collateralVaultRebase
            : TokenType.syntheticRebase,
        token:
          chain === COLLATERAL_CHAIN ? COMPOUND_STAKING_REWARDS : undefined,
      },
    ]),
  );
};
