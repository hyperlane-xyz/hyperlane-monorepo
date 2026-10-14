import { ChainMap, IgpConfig } from '@hyperlane-xyz/sdk';
import { objMap, rootLogger } from '@hyperlane-xyz/utils';

import {
  getLocalStorageGasOracleConfigOverride,
  getOverheadWithOverrides,
} from '../../../src/config/gas-oracle.js';
import { tokens } from '../../../src/config/warp.js';

import gasPrices from './gasPrices.json' with { type: 'json' };
import { supportedChainNames } from './supportedChainNames.js';
import tokenPrices from './tokenPrices.json' with { type: 'json' };

// Existing USDC and USDT deployments, including bridged USDT on Base/Optimism
// and the USDT address upgraded to USD₮0 on Arbitrum.
// Ink uses native USDC and USDT0. Arc uses only its 6-decimal USDC ERC20
// interface; its native USDC gas token uses 18 decimals. Arc USDT and Robinhood
// are excluded until their token addresses are verified.
const feeTokens: ChainMap<string[]> = {
  arc: [tokens.arc.USDC],
  arbitrum: [tokens.arbitrum.USDC, tokens.arbitrum.USDT],
  base: [tokens.base.USDC, tokens.base.USDT],
  ethereum: [tokens.ethereum.USDC, tokens.ethereum.USDT],
  ink: [tokens.ink.USDC, tokens.ink.USDT0],
  optimism: [tokens.optimism.USDC, tokens.optimism.USDT],
};

// Price both stablecoins at their $1 peg; these are deployment-time quotes,
// using the same remote gas/native-price snapshots as the native IGP config.
// Reconcile the oracles if either stablecoin departs from its peg.
const feeToken = { price: '1', decimals: 6 };

let tokenGasOracleConfigsCache:
  | ChainMap<NonNullable<IgpConfig['tokenOracleConfig']>>
  | undefined;

/** Builds per-token oracles lazily, preserving native IGP margins and USD floors. */
export function getTokenGasOracleConfigs(): ChainMap<
  NonNullable<IgpConfig['tokenOracleConfig']>
> {
  if (!tokenGasOracleConfigsCache) {
    const flooredPairs = new Set<string>();
    tokenGasOracleConfigsCache = objMap(feeTokens, (local, addresses) => {
      const oracleConfig = getLocalStorageGasOracleConfigOverride(
        local,
        supportedChainNames.filter((remote) => remote !== local),
        tokenPrices,
        gasPrices,
        getOverheadWithOverrides,
        true,
        ({ local, remote }) => flooredPairs.add(`${local} -> ${remote}`),
        feeToken,
      );
      return Object.fromEntries(
        addresses.map((address) => [address, oracleConfig]),
      );
    });
    if (flooredPairs.size > 0) {
      rootLogger.warn(
        `${flooredPairs.size} stablecoin gas oracle pair(s) floored the exchange rate to 1 after precision rebalance: ${[...flooredPairs].join(', ')}`,
      );
    }
  }
  return tokenGasOracleConfigsCache;
}
