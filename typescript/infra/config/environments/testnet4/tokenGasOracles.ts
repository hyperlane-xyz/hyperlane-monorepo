import {
  ChainGasOracleParams,
  ChainMap,
  ChainName,
  GasPriceConfig,
  IgpConfig,
  ProtocolAgnositicGasOracleConfigWithTypicalCost,
  getLocalStorageGasOracleConfig,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { EXCHANGE_RATE_MARGIN_PCT } from '../../../src/config/gas-oracle.js';
import { mustGetChainNativeToken } from '../../../src/utils/utils.js';

import rawGasPrices from './gasPrices.json' with { type: 'json' };
import { supportedChainNames } from './supportedChainNames.js';
import rawTokenPrices from './tokenPrices.json' with { type: 'json' };

const tokenPrices: ChainMap<string> = rawTokenPrices;
const gasPrices: ChainMap<GasPriceConfig> = rawGasPrices;

/**
 * Per-fee-token IGP gas oracle configs for ERC20-denominated interchain gas
 * payments, keyed by:
 *
 *   local chain -> fee token address -> remote chain -> oracle config
 *
 * The wiring in `igp.ts` merges the entry for each local chain into that
 * chain's `IgpConfig.tokenOracleConfig`, which the SDK turns into per-fee-token
 * `StorageGasOracle` deployments + `setTokenGasOracles` calls on the IGP.
 *
 * Token-IGP rollout changes stay contained to this file. To enable a token on
 * a chain, add an entry here. Only applies to non-legacy IGPs (>= 11.3.0,
 * EIP-1153 transient storage); legacy chains reject it. The exchange rate is
 * denominated in the fee token (price of the remote native token quoted in the
 * fee token), not the local native token.
 */

// Seismic is moving to sUSDC-only for gas; SIZE is not a user-facing asset, so
// outbound dispatches pay the IGP fee in sUSDC instead of native SIZE.
// https://seismic-testnet.socialscan.io/src20token/0x790701048922e265105fd6a4467a2901c2201c43
const SEISMIC: ChainName = 'seismictestnet';
const SEISMIC_SUSDC = '0x790701048922e265105fd6a4467a2901c2201c43';
const SEISMIC_SUSDC_DECIMALS = 6;
// sUSDC is USD-pegged, so priced at $1: quotes then land at the same USD value
// as the native SIZE quote, just denominated in sUSDC. This testnet-only
// constant has no depeg or staleness guard; replace it with a live/staleness-
// checked price source before any mainnet reuse.
const SEISMIC_SUSDC_PRICE = '1';

/**
 * Builds the sUSDC-denominated oracle config for each Seismic remote by reusing
 * the native gas-oracle machinery with sUSDC substituted as Seismic's local fee
 * token (its price and decimals). This makes the exchange rate resolve to the
 * remote native token priced in sUSDC, adjusted for sUSDC's 6 decimals.
 */
function seismicSusdcOracleConfigs(): ChainMap<ProtocolAgnositicGasOracleConfigWithTypicalCost> {
  const remotes = supportedChainNames.filter((chain) => chain !== SEISMIC);

  const gasOracleParams: ChainMap<ChainGasOracleParams> = {};
  for (const chain of [SEISMIC, ...remotes]) {
    gasOracleParams[chain] = {
      gasPrice: gasPrices[chain],
      nativeToken: {
        price: chain === SEISMIC ? SEISMIC_SUSDC_PRICE : tokenPrices[chain],
        decimals:
          chain === SEISMIC
            ? SEISMIC_SUSDC_DECIMALS
            : mustGetChainNativeToken(chain).decimals,
      },
    };
  }

  return getLocalStorageGasOracleConfig({
    local: SEISMIC,
    localProtocolType: ProtocolType.Ethereum,
    gasOracleParams,
    exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
  });
}

export const tokenGasOracleConfigs: ChainMap<
  NonNullable<IgpConfig['tokenOracleConfig']>
> = {
  [SEISMIC]: {
    [SEISMIC_SUSDC]: seismicSusdcOracleConfigs(),
  },
};
