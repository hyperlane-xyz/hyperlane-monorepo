import {
  ChainGasOracleParams,
  ChainMap,
  ChainName,
  GasPriceConfig,
  IgpConfig,
  ProtocolAgnositicGasOracleConfig,
  getLocalStorageGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { EXCHANGE_RATE_MARGIN_PCT } from '../../../src/config/gas-oracle.js';
import { mustGetChainNativeToken } from '../../../src/utils/utils.js';

import rawGasPrices from './gasPrices.json' with { type: 'json' };
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const gasPrices: ChainMap<GasPriceConfig> = rawGasPrices;
const tokenPrices: ChainMap<string> = rawTokenPrices;

function buildTokenOracleConfig(
  chain: ChainName,
  feeTokenPrice: string,
  feeTokenDecimals: number,
): ChainMap<ProtocolAgnositicGasOracleConfig> {
  const oracleRemotes = supportedChainNames.filter(
    (c) => c !== chain && gasPrices[c] && tokenPrices[c],
  );

  const gasOracleParams: ChainMap<ChainGasOracleParams> = {
    // Substitute the ERC20 fee token as the "local native token" so the
    // exchange rate resolves to: remote-native priced in fee-token.
    [chain]: {
      gasPrice: gasPrices[chain] ?? { amount: '1', decimals: 9 },
      nativeToken: { price: feeTokenPrice, decimals: feeTokenDecimals },
    },
  };
  for (const remote of oracleRemotes) {
    gasOracleParams[remote] = {
      gasPrice: gasPrices[remote],
      nativeToken: {
        price: tokenPrices[remote],
        decimals: mustGetChainNativeToken(remote).decimals,
      },
    };
  }

  return getLocalStorageGasOracleConfig({
    local: chain,
    localProtocolType: ProtocolType.Ethereum,
    gasOracleParams,
    exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
  });
}

/**
 * Per-fee-token IGP gas oracle configs, keyed by:
 *   local chain -> fee token address -> remote chain -> oracle config
 *
 * Merged into each chain's IgpConfig.tokenOracleConfig in igp.ts, which
 * deploys a StorageGasOracle per fee token and calls setTokenGasOracles.
 * Only applies to non-legacy IGPs (>= 11.3.0).
 */
export const tokenGasOracleConfigs: ChainMap<
  NonNullable<IgpConfig['tokenOracleConfig']>
> = {
  // Tempo uses pathUSD ($1 USD stablecoin, 6 decimals) for gas payments.
  tempo: {
    '0x20c0000000000000000000000000000000000000': buildTokenOracleConfig(
      'tempo',
      '1',
      6,
    ),
  },
};
