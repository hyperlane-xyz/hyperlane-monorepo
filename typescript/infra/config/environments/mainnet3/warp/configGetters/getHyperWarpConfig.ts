import { ChainMap, HypTokenRouterConfig, TokenType } from '@hyperlane-xyz/sdk';

import { RouterConfigWithoutOwner } from '../../../../../src/config/warp.js';

export const COLLATERAL_CHAIN = 'ethereum';

const TOKEN_CONFIG = {
  name: 'Hyperlane',
  symbol: 'HYPER',
  decimals: 18,
};

const TOKEN_CHAINS = [
  COLLATERAL_CHAIN,
  'base',
  'optimism',
  'arbitrum',
  'bsc',
] as const;

const STAKED_TOKEN_CONFIG = {
  name: 'Staked HYPER',
  symbol: 'stHYPER',
  decimals: TOKEN_CONFIG.decimals,
};

const STAKED_TOKEN_CHAINS = [COLLATERAL_CHAIN, 'bsc'] as const;

const STAGING = {
  INITIAL_SUPPLY: (
    1_000_000_000n *
    10n ** BigInt(TOKEN_CONFIG.decimals)
  ).toString(),
  OWNERS: {
    ethereum: '0xf0b850930ede8807e7F472b610b017c187E0e493',
    // get-owner-ica output
    arbitrum: '0xC44C6eb6Fe37A6389B6b741A0A17dcB6b1aAbC89',
    base: '0xf189b22a6Be9378C5cDa94a6E72C6d18611291cA',
    optimism: '0x6Fd6Be005D6e122b51b33044968d6CDB5F7A292c',
    bsc: '0xaE1DA73F3aB27F30b32239114d4d14c789D64176',
  },
  COMPOUND_STAKING_REWARDS: '0x9FB258cbd8415C4Fda62092003FCB54F60Af670B',
};

export const PRODUCTION = {
  INITIAL_SUPPLY: (
    802_666_667n *
    10n ** BigInt(TOKEN_CONFIG.decimals)
  ).toString(),
  OWNERS: {
    ethereum: '',
    // get-owner-ica output
    arbitrum: '',
    base: '',
    optimism: '',
    bsc: '',
  },
  COMPOUND_STAKING_REWARDS: '',
};

const getHyperWarpConfig =
  (envConfig: typeof STAGING) =>
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    return Object.fromEntries(
      TOKEN_CHAINS.map((chain) => {
        const config = {
          ...routerConfig[chain],
          ...TOKEN_CONFIG,
          owner: envConfig.OWNERS[chain],
        };

        if (chain === COLLATERAL_CHAIN) {
          return [
            chain,
            {
              type: TokenType.hyperToken,
              initialSupply: envConfig.INITIAL_SUPPLY,
              ...config,
            },
          ];
        } else {
          return [
            chain,
            {
              type: TokenType.synthetic,
              ...config,
            },
          ];
        }
      }),
    );
  };

const getStakedHyperWarpConfig =
  (envConfig: typeof STAGING) =>
  async (
    routerConfig: ChainMap<RouterConfigWithoutOwner>,
  ): Promise<ChainMap<HypTokenRouterConfig>> => {
    return Object.fromEntries(
      STAKED_TOKEN_CHAINS.map((chain) => {
        const config = {
          ...routerConfig[chain],
          ...STAKED_TOKEN_CONFIG,
          owner: envConfig.OWNERS[chain],
        };

        if (chain === COLLATERAL_CHAIN) {
          return [
            chain,
            {
              type: TokenType.collateralVaultRebase,
              token: envConfig.COMPOUND_STAKING_REWARDS,
              ...config,
            },
          ];
        } else {
          return [
            chain,
            {
              type: TokenType.syntheticRebase,
              collateralChainName: COLLATERAL_CHAIN,
              ...config,
            },
          ];
        }
      }),
    );
  };

export const getHyperWarpConfigStaging = getHyperWarpConfig(STAGING);
export const getHyperWarpConfigProduction = getHyperWarpConfig(PRODUCTION);
export const getStakedHyperWarpConfigStaging =
  getStakedHyperWarpConfig(STAGING);
export const getStakedHyperWarpConfigProduction =
  getStakedHyperWarpConfig(PRODUCTION);
