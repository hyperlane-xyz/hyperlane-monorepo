import { BigNumber as BigNumberJs } from 'bignumber.js';
import { BigNumber } from 'ethers';
import { z } from 'zod';

import {
  ChainGasOracleParams,
  ChainMap,
  ChainName,
  GasPriceConfig,
  ProtocolAgnositicGasOracleConfig,
  ProtocolAgnositicGasOracleConfigSchema,
  ProtocolAgnositicGasOracleConfigWithTypicalCost,
  ZBigNumberish,
  defaultMultisigConfigs,
  getLocalStorageGasOracleConfig,
  getProtocolExchangeRateScale,
  multisigIsmVerificationCost,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  assert,
  convertDecimals,
  fromWei,
  rootLogger,
  toWei,
} from '@hyperlane-xyz/utils';
import { readJson } from '@hyperlane-xyz/utils/fs';

import { getChain } from '../../config/registry.js';
import { mustGetChainNativeToken } from '../utils/utils.js';

// gas oracle configs for each chain, which includes
// a map for each chain's remote chains
export type AllStorageGasOracleConfigs = ChainMap<
  ChainMap<ProtocolAgnositicGasOracleConfigWithTypicalCost>
>;

/**
 * Zod schemas for validating gas oracle config files
 */

export type OracleConfig = z.infer<typeof OracleConfigSchema>;
export const OracleConfigSchema = ProtocolAgnositicGasOracleConfigSchema.extend(
  {
    tokenExchangeRate: ZBigNumberish, // override to coerce/canonicalize
    gasPrice: ZBigNumberish, // override to coerce/canonicalize
    // we expect infra-generated configs to always have token decimals
    tokenDecimals: z.number().int().nonnegative(),
  },
);

/**
 * Gas oracle configuration with optional overhead value.
 * Used for configuring IGP gas oracles across different chains.
 */
export type GasOracleConfigWithOverhead = z.infer<
  typeof GasOracleConfigWithOverheadSchema
>;
const GasOracleConfigWithOverheadSchema = z.object({
  oracleConfig: OracleConfigSchema,
  overhead: z.number().int().nonnegative().optional(),
});

// zod validation for the gas oracle config file
const GasOracleConfigFileSchema = z.record(
  z.string().min(1, 'Chain name cannot be empty'),
  z.record(
    z.string().min(1, 'Remote chain name cannot be empty'),
    GasOracleConfigWithOverheadSchema,
  ),
);

/**
 * Load and validate gas oracle config file
 */
export function loadAndValidateGasOracleConfig(
  configPath: string,
): ChainMap<ChainMap<GasOracleConfigWithOverhead>> {
  const rawConfig = readJson(configPath);

  try {
    const validated = GasOracleConfigFileSchema.parse(rawConfig);
    // The validated config is now compatible with GasOracleConfigWithOverhead
    return validated as ChainMap<ChainMap<GasOracleConfigWithOverhead>>;
  } catch (error) {
    if (error instanceof z.ZodError) {
      rootLogger.error('Gas oracle config validation failed:');
      error.issues.forEach((issue) => {
        rootLogger.error(`  ${issue.path.join('.')}: ${issue.message}`);
      });
      throw new Error(
        `Invalid gas oracle config file at ${configPath}. Please ensure all fields are properly formatted.`,
      );
    }
    throw error;
  }
}

// Overcharge by 50% to account for market making risk
export const EXCHANGE_RATE_MARGIN_PCT = 50;

// Gets the StorageGasOracleConfigWithTypicalCost for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
function getLocalStorageGasOracleConfigOverride(
  local: ChainName,
  remotes: ChainName[],
  tokenPrices: ChainMap<string>,
  gasPrices: ChainMap<GasPriceConfig>,
  getOverhead: (local: ChainName, remote: ChainName) => number,
  applyMinUsdCost: boolean,
): ChainMap<ProtocolAgnositicGasOracleConfigWithTypicalCost> {
  const localProtocolType = getChain(local).protocol;
  const localExchangeRateScale =
    getProtocolExchangeRateScale(localProtocolType);
  const localNativeTokenDecimals = mustGetChainNativeToken(local).decimals;

  // Construct the gas oracle params for each remote chain
  const gasOracleParams = [local, ...remotes].reduce((agg, remote) => {
    agg[remote] = {
      gasPrice: gasPrices[remote],
      nativeToken: {
        price: tokenPrices[remote],
        decimals: mustGetChainNativeToken(remote).decimals,
      },
    };
    return agg;
  }, {} as ChainMap<ChainGasOracleParams>);

  const typicalCostGetter = (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ) => {
    const remoteProtocolType = getChain(remote).protocol;

    const typicalRemoteGasAmount = getTypicalRemoteGasAmount(
      local,
      remote,
      remoteProtocolType,
      getOverhead,
    );
    const localTokenUsdPrice = parseFloat(tokenPrices[local]);
    const typicalIgpQuoteUsd = getUsdQuote(
      localTokenUsdPrice,
      localExchangeRateScale,
      localNativeTokenDecimals,
      localProtocolType,
      gasOracleConfig,
      typicalRemoteGasAmount,
    );
    return {
      handleGasAmount: getTypicalHandleGasAmount(remoteProtocolType),
      totalGasAmount: typicalRemoteGasAmount,
      totalUsdCost: typicalIgpQuoteUsd,
    };
  };

  // Modifier to adjust the gas price to meet minimum USD cost requirements.
  const gasPriceModifier = (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ): BigNumberJs.Value => {
    if (!applyMinUsdCost) {
      return gasOracleConfig.gasPrice;
    }

    const typicalRemoteGasAmount = getTypicalRemoteGasAmount(
      local,
      remote,
      getChain(remote).protocol,
      getOverhead,
    );
    const localTokenUsdPrice = parseFloat(tokenPrices[local]);
    const typicalIgpQuoteUsd = getUsdQuote(
      localTokenUsdPrice,
      localExchangeRateScale,
      localNativeTokenDecimals,
      localProtocolType,
      gasOracleConfig,
      typicalRemoteGasAmount,
    );

    const minUsdCost = getMinUsdCost(local, remote);

    // If the quote is already above the minimum cost, don't adjust the gas price!
    if (typicalIgpQuoteUsd >= minUsdCost) {
      return gasOracleConfig.gasPrice;
    }

    // If we've gotten here, the quote is less than the minimum cost and we
    // need to adjust the gas price.

    // The minimum quote we want on the origin, in the lowest origin denomination.
    const minIgpQuoteWei = toWei(
      new BigNumberJs(minUsdCost).div(localTokenUsdPrice),
      localNativeTokenDecimals,
    );
    // The new gas price that will give us the minimum quote.
    // We use a BigNumberJs to allow for non-integer gas prices.
    // Later in the process, this is made integer-friendly.
    // This calculation expects that the token exchange rate accounts
    // for decimals.
    let newGasPrice = new BigNumberJs(minIgpQuoteWei)
      .times(localExchangeRateScale.toString())
      .div(
        new BigNumberJs(gasOracleConfig.tokenExchangeRate).times(
          typicalRemoteGasAmount,
        ),
      );

    if (localProtocolType === ProtocolType.Sealevel) {
      assert(
        gasOracleConfig.tokenDecimals,
        'Token decimals must be defined for use by local Sealevel chains',
      );
      // On Sealevel, the exchange rate doesn't consider decimals.
      // We therefore explicitly convert decimals to remote decimals.
      newGasPrice = convertDecimals(
        localNativeTokenDecimals,
        gasOracleConfig.tokenDecimals,
        newGasPrice.toString(),
      );
    }
    return newGasPrice;
  };

  return getLocalStorageGasOracleConfig({
    local,
    localProtocolType,
    gasOracleParams,
    exchangeRateMarginPct: EXCHANGE_RATE_MARGIN_PCT,
    gasPriceModifier,
    typicalCostGetter,
  });
}

export function getTypicalHandleGasAmount(
  remoteProtocolType: ProtocolType,
): number {
  if (remoteProtocolType === ProtocolType.Starknet) {
    return 5_000_000;
  }

  if (remoteProtocolType === ProtocolType.Radix) {
    return 30_000_000;
  }

  // A fairly arbitrary amount of gas used in a message's handle function,
  // generally fits most VMs.
  return 50_000;
}

export function getTypicalRemoteGasAmount(
  local: ChainName,
  remote: ChainName,
  remoteProtocolType: ProtocolType,
  getOverhead: (local: ChainName, remote: ChainName) => number,
): number {
  return (
    getOverhead(local, remote) + getTypicalHandleGasAmount(remoteProtocolType)
  );
}

function getMinUsdCost(local: ChainName, remote: ChainName): number {
  // By default, min cost is 20 cents
  let minUsdCost = 0.2;

  // For all SVM chains, min cost is 0.50 USD to cover rent needs
  if (getChain(remote).protocol === ProtocolType.Sealevel) {
    minUsdCost = Math.max(minUsdCost, 0.5);
  }

  const remoteMinCostOverrides: ChainMap<number> = {
    // mitosis
    mitosis: 0.1,

    // For all SVM chains, min cost is 0.50 USD to cover rent needs
    // For Ethereum L2s, we need to account for the L1 DA costs that
    // aren't accounted for directly in the gas price.
    ancient8: 0.5,
    blast: 0.5,
    mantapacific: 0.5,
    polygonzkevm: 0.5,

    // Scroll is more expensive than the rest due to higher L1 fees
    scroll: 1.5,
    taiko: 0.5,
    // Nexus adjustment
    neutron: 0.5,
    // For Solana, special min cost
    solanamainnet: 1.2,
  };

  if (local === 'ethereum' && remote === 'solanamainnet') {
    minUsdCost = 0.5;
    remoteMinCostOverrides['solanamainnet'] = 0.9;
  }

  const override = remoteMinCostOverrides[remote];
  if (override !== undefined) {
    minUsdCost = Math.max(minUsdCost, override);
  }

  return minUsdCost;
}

function getUsdQuote(
  localTokenUsdPrice: number,
  localExchangeRateScale: BigNumber,
  localNativeTokenDecimals: number,
  localProtocolType: ProtocolType,
  gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  remoteGasAmount: number,
): number {
  let quote = BigNumber.from(gasOracleConfig.gasPrice)
    .mul(gasOracleConfig.tokenExchangeRate)
    .mul(remoteGasAmount)
    .div(localExchangeRateScale)
    .toString();
  if (localProtocolType === ProtocolType.Sealevel) {
    assert(
      gasOracleConfig.tokenDecimals,
      'Token decimals must be defined for use by local Sealevel chains',
    );
    // Convert decimals to local decimals
    quote = convertDecimals(
      gasOracleConfig.tokenDecimals,
      localNativeTokenDecimals,
      quote,
    ).toString();
  }
  const quoteUsd =
    localTokenUsdPrice * parseFloat(fromWei(quote, localNativeTokenDecimals));

  return quoteUsd;
}

// cosmwasm warp route somewhat arbitrarily chosen
const FOREIGN_DEFAULT_OVERHEAD = 600_000;

// Overhead for interchain messaging
export function getOverhead(local: ChainName, remote: ChainName): number {
  const remoteProtocol = getChain(remote).protocol;

  if (remoteProtocol === ProtocolType.Ethereum) {
    return multisigIsmVerificationCost(
      defaultMultisigConfigs[local].threshold,
      defaultMultisigConfigs[local].validators.length,
    );
  }

  if (remoteProtocol === ProtocolType.Starknet) {
    return 10_000_000 + 40_000_000 * defaultMultisigConfigs[local].threshold;
  }

  // Default non-EVM overhead
  return FOREIGN_DEFAULT_OVERHEAD;
}

// Gets the map of remote gas oracle configs for each local chain
export function getAllStorageGasOracleConfigs(
  chainNames: ChainName[],
  tokenPrices: ChainMap<string>,
  gasPrices: ChainMap<GasPriceConfig>,
  getOverhead: (local: ChainName, remote: ChainName) => number,
  applyMinUsdCost: boolean = true,
): AllStorageGasOracleConfigs {
  // Ensure all chains have token prices and gas prices by adding stub values
  chainNames.forEach((chain) => {
    if (!tokenPrices[chain]) {
      rootLogger.warn(`Missing token price for ${chain}, using default value`);
      tokenPrices[chain] = '1';
    }
    if (!gasPrices[chain]) {
      rootLogger.warn(`Missing gas price for ${chain}, using default value`);
      gasPrices[chain] = {
        amount: '1',
        decimals: 9,
      };
    }
  });

  return chainNames
    .filter((chain) => {
      // For now, only support Ethereum and Sealevel chains.
      // Cosmos chains should be supported in the future, but at the moment
      // are more subject to loss of precision issues in the exchange rate,
      // where we'd need to scale the gas price accordingly.
      const protocol = getChain(chain).protocol;
      return (
        protocol === ProtocolType.Ethereum || protocol === ProtocolType.Sealevel
      );
    })
    .reduce((agg, local) => {
      const remotes = chainNames.filter((chain) => local !== chain);
      return {
        ...agg,
        [local]: getLocalStorageGasOracleConfigOverride(
          local,
          remotes,
          tokenPrices,
          gasPrices,
          getOverhead,
          applyMinUsdCost,
        ),
      };
    }, {}) as AllStorageGasOracleConfigs;
}

// 5% threshold, adjust as needed
export const DEFAULT_DIFF_THRESHOLD_PCT = 5;

/**
 * Gets a safe numeric value with fallback, handling NaN and undefined cases
 */
export const getSafeNumericValue = (
  value: string | number | undefined,
  fallback: string | number,
): number => {
  const parsed =
    value && !isNaN(Number(value)) ? Number(value) : Number(fallback);
  return parsed;
};

/**
 * Determines if a price should be updated based on percentage difference threshold
 */
export const shouldUpdatePrice = (
  newPrice: number,
  prevPrice: number,
  thresholdPct: number = DEFAULT_DIFF_THRESHOLD_PCT,
): boolean => {
  if (prevPrice === 0) return true; // Avoid division by zero
  const diff = Math.abs(newPrice - prevPrice) / prevPrice;
  return diff > thresholdPct / 100;
};

/**
 * Generic price update logic that can be reused across different price types
 */
export const updatePriceIfNeeded = <T>(
  newValue: T,
  prevValue: T,
  newNumeric: number,
  prevNumeric: number,
  thresholdPct: number = DEFAULT_DIFF_THRESHOLD_PCT,
): T => {
  return shouldUpdatePrice(newNumeric, prevNumeric, thresholdPct)
    ? newValue
    : prevValue;
};
