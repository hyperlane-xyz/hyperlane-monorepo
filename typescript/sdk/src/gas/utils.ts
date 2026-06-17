import { Provider } from '@ethersproject/providers';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { ethers } from 'ethers';

import {
  ProtocolType,
  assert,
  convertDecimals,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { getProtocolExchangeRateDecimals } from '../consts/igp.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { AgentCosmosGasPrice } from '../metadata/agentConfig.js';
import type { MultiProviderAdapter } from '../providers/MultiProviderAdapter.js';
import { ChainMap, ChainName } from '../types.js';
import { getCosmosRegistryChain } from '../utils/cosmos.js';

import {
  IgpCostData,
  ProtocolAgnositicGasOracleConfig,
  ProtocolAgnositicGasOracleConfigWithTypicalCost,
} from './oracle/types.js';

export interface GasPriceConfig {
  amount: string;
  decimals: number;
}

export interface NativeTokenPriceConfig {
  price: string;
  decimals: number;
}

export interface ChainGasOracleParams {
  gasPrice: GasPriceConfig;
  nativeToken: NativeTokenPriceConfig;
}

export async function getGasPrice(
  mpp: MultiProviderAdapter,
  chain: string,
): Promise<GasPriceConfig> {
  const protocolType = mpp.getProtocol(chain);
  switch (protocolType) {
    case ProtocolType.Tron:
    case ProtocolType.Ethereum: {
      const provider = mpp.getProvider(chain);
      const gasPrice = await (provider.provider as Provider).getGasPrice();
      return {
        amount: ethers.utils.formatUnits(gasPrice, 'gwei'),
        decimals: 9,
      };
    }
    case ProtocolType.Cosmos:
    case ProtocolType.CosmosNative: {
      const { amount } = await getCosmosChainGasPrice(chain, mpp);
      return {
        amount,
        decimals: 1,
      };
    }
    case ProtocolType.Sealevel:
      // TODO get a reasonable value
      return {
        amount: '0.001',
        decimals: 9,
      };
    default:
      throw new Error(`Unsupported protocol type: ${protocolType}`);
  }
}

// Gets the gas price for a Cosmos chain
export async function getCosmosChainGasPrice(
  chain: ChainName,
  chainMetadataManager: ChainMetadataManager,
): Promise<AgentCosmosGasPrice> {
  const metadata = chainMetadataManager.getChainMetadata(chain);
  if (!metadata) {
    throw new Error(`No metadata found for Cosmos chain ${chain}`);
  }
  if (
    metadata.protocol !== ProtocolType.Cosmos &&
    metadata.protocol !== ProtocolType.CosmosNative
  ) {
    throw new Error(`Chain ${chain} is not a Cosmos chain`);
  }

  // Use the cosmos registry gas price first.
  let cosmosRegistryChain;
  try {
    cosmosRegistryChain = await getCosmosRegistryChain(chain);
  } catch (err) {
    // Fallback to our registry gas price from the metadata.
    if (metadata.gasPrice) {
      return metadata.gasPrice;
    }
    throw new Error(
      `No gas price found for Cosmos chain ${chain} in the registry or metadata`,
      {
        cause: err,
      },
    );
  }

  const nativeToken = metadata.nativeToken;
  if (!nativeToken) {
    throw new Error(`No native token found for Cosmos chain ${chain}`);
  }
  if (!nativeToken.denom) {
    throw new Error(`No denom found for native token on Cosmos chain ${chain}`);
  }

  const fee = cosmosRegistryChain.fees?.fee_tokens.find(
    (fee: { denom: string }) => {
      return (
        fee.denom === nativeToken.denom || fee.denom === `u${nativeToken.denom}`
      );
    },
  );
  if (!fee || fee.average_gas_price === undefined) {
    throw new Error(`No gas price found for Cosmos chain ${chain}`);
  }

  return {
    denom: fee.denom,
    amount: fee.average_gas_price.toString(),
  };
}

// Gets the exchange rate of the remote quoted in local tokens, not accounting for decimals.
function getTokenExchangeRate({
  local,
  remote,
  tokenPrices,
  exchangeRateMarginPct,
}: {
  local: ChainName;
  remote: ChainName;
  tokenPrices: ChainMap<string>;
  exchangeRateMarginPct: number;
}): InstanceType<typeof BigNumberJs> {
  // Workaround for chicken-egg dependency problem.
  // We need to provide some default value here to satisfy the config on initial load,
  // whilst knowing that it will get overwritten when a script actually gets run.
  const defaultValue = '1';
  const localValue = new BigNumberJs(tokenPrices[local] ?? defaultValue);
  const remoteValue = new BigNumberJs(tokenPrices[remote] ?? defaultValue);

  // Note this does not account for decimals!
  let exchangeRate = remoteValue.div(localValue);
  // Apply the premium
  exchangeRate = exchangeRate.times(100 + exchangeRateMarginPct).div(100);

  assert(
    exchangeRate.isGreaterThan(0),
    'Exchange rate must be greater than 0, possible loss of precision',
  );
  return exchangeRate;
}

// Scales the (decimal-adjusted) exchange rate by the protocol's fixed-point
// multiplier. Returns a float that may be < 1 (e.g. for a low-decimal fee token
// paying for a high-decimal native chain); rounding to an integer and any
// precision rebalancing against the gas price happen later in
// adjustForPrecisionLoss.
function scaleProtocolExchangeRate(
  localProtocolType: ProtocolType,
  exchangeRate: InstanceType<typeof BigNumberJs>,
): InstanceType<typeof BigNumberJs> {
  const multiplierDecimals = getProtocolExchangeRateDecimals(localProtocolType);
  return exchangeRate.times(new BigNumberJs(10).pow(multiplierDecimals));
}

// Gets the StorageGasOracleConfig for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
// A gasPriceModifier can be supplied to adjust the gas price based on a prospective
// gasOracleConfig.
// Values take into consideration the local chain's needs depending on the protocol type,
// e.g. the expected decimals of the token exchange rate, or whether to account for
// a native token decimal difference in the exchange rate.
// Therefore the values here can be applied directly to the chain's gas oracle.
export function getLocalStorageGasOracleConfig({
  local,
  localProtocolType,
  gasOracleParams,
  exchangeRateMarginPct,
  gasPriceModifier,
  typicalCostGetter,
}: {
  local: ChainName;
  localProtocolType: ProtocolType;
  gasOracleParams: ChainMap<ChainGasOracleParams>;
  exchangeRateMarginPct: number;
  gasPriceModifier?: (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ) => Parameters<typeof BigNumberJs>[0];
  typicalCostGetter?: (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ) => IgpCostData;
}): ChainMap<ProtocolAgnositicGasOracleConfig> {
  const remotes = Object.keys(gasOracleParams).filter(
    (remote) => remote !== local,
  );
  const tokenPrices: ChainMap<string> = objMap(
    gasOracleParams,
    (chain) => gasOracleParams[chain].nativeToken.price,
  );
  const localDecimals = gasOracleParams[local].nativeToken.decimals;
  return remotes.reduce((agg, remote) => {
    const remoteDecimals = gasOracleParams[remote].nativeToken.decimals;
    // The exchange rate, not yet accounting for decimals, and potentially
    // floating point.
    let exchangeRateFloat = getTokenExchangeRate({
      local,
      remote,
      tokenPrices,
      exchangeRateMarginPct,
    });

    if (localProtocolType !== ProtocolType.Sealevel) {
      // On all chains other than Sealevel, we need to adjust the exchange rate for decimals.
      exchangeRateFloat = convertDecimals(
        remoteDecimals,
        localDecimals,
        exchangeRateFloat,
      );
    }

    // Scale the exchange rate by the protocol's fixed-point factor. Kept as a
    // float here; adjustForPrecisionLoss does the final integer rounding (and
    // rebalances against the gas price if it would otherwise underflow).
    const scaledExchangeRate = scaleProtocolExchangeRate(
      localProtocolType,
      exchangeRateFloat,
    );

    // First parse the gas price as a number, so we have floating point precision.
    // Recall it's possible to have gas prices that are not integers, even
    // after converting to the "wei" version of the token.
    const gasPrice = new BigNumberJs(
      gasOracleParams[remote].gasPrice.amount,
    ).times(new BigNumberJs(10).pow(gasOracleParams[remote].gasPrice.decimals));
    if (gasPrice.isNaN()) {
      throw new Error(
        `Invalid gas price for chain ${remote}: ${gasOracleParams[remote].gasPrice.amount}`,
      );
    }

    // Get a prospective gasOracleConfig, adjusting the gas price and exchange rate
    // as needed to account for precision loss (e.g. if the gas price is super small).
    let gasOracleConfig: ProtocolAgnositicGasOracleConfigWithTypicalCost =
      adjustForPrecisionLoss(gasPrice, scaledExchangeRate, remoteDecimals);

    // Apply the modifier if provided.
    if (gasPriceModifier) {
      // Once again adjust for precision loss after applying the modifier.
      gasOracleConfig = adjustForPrecisionLoss(
        gasPriceModifier(local, remote, gasOracleConfig),
        new BigNumberJs(gasOracleConfig.tokenExchangeRate),
        remoteDecimals,
      );
    }

    if (typicalCostGetter) {
      gasOracleConfig.typicalCost = typicalCostGetter(
        local,
        remote,
        gasOracleConfig,
      );
    }
    return {
      ...agg,
      [remote]: gasOracleConfig,
    };
  }, {} as ChainMap<ProtocolAgnositicGasOracleConfig>);
}

// Floor for the gas price after rebalancing a sub-unit exchange rate. Because
// the final gas price is ceiled, keeping the rebalanced value at least 1000
// bounds the relative quote error from that ceil to < 1 / 1000 = 0.1%.
const MIN_REBALANCED_GAS_PRICE = 1000;

function decimalMagnitude(value: InstanceType<typeof BigNumberJs>): number {
  if (value.lt(1)) return 0;
  return value.integerValue(BigNumberJs.ROUND_FLOOR).toFixed(0).length - 1;
}

function adjustForPrecisionLoss(
  gasPrice: Parameters<typeof BigNumberJs>[0],
  exchangeRate: InstanceType<typeof BigNumberJs>,
  remoteDecimals: number,
): ProtocolAgnositicGasOracleConfig {
  let newGasPrice = new BigNumberJs(gasPrice);
  let newExchangeRate = exchangeRate;

  // When the fee token has fewer decimals than the remote native token (e.g. a
  // 6-decimal ERC20 fee token paying for an 18-decimal native chain), decimal
  // conversion can push the scaled exchange rate below 1, where rounding to an
  // integer would badly misprice (or zero out) the quote. The quote is the
  // product gasPrice * exchangeRate, so shift magnitude from the gas price into
  // the exchange rate by a power of ten: the product (and thus the quote) is
  // preserved while the on-chain exchange rate keeps its precision. No-op for
  // same-decimal native pairs, where the scaled rate is already >> 1.
  if (newExchangeRate.lt(1)) {
    const shiftMagnitude = decimalMagnitude(
      newGasPrice.div(MIN_REBALANCED_GAS_PRICE),
    );

    if (shiftMagnitude > 0) {
      const factor = new BigNumberJs(10).pow(shiftMagnitude);
      newExchangeRate = newExchangeRate.times(factor);
      newGasPrice = newGasPrice.div(factor);
    }

    if (newExchangeRate.lt(1)) {
      // Known limitation: gas prices below 10 * MIN_REBALANCED_GAS_PRICE do
      // not have a full decimal digit of headroom to shift while preserving the
      // final ceil rounding-error bound. In that no-headroom band, keep the
      // original gas price and fall back to the minimum representable exchange
      // rate instead of introducing a larger ceil error.
      rootLogger.warn(
        `Token exchange rate remains below 1 after precision rebalance; falling back to minimum on-chain exchange rate. Original gas price: ${new BigNumberJs(
          gasPrice,
        ).toString()}, original exchange rate: ${exchangeRate.toString()}`,
      );
    }
  }

  // We may have very little precision, and ultimately need an integer value for
  // the gas price that will be set on-chain. If this is the case, we scale up the
  // gas price and scale down the exchange rate by the same factor.
  if (newGasPrice.lt(10) && !newGasPrice.mod(1).isZero()) {
    // Scale up the gas price by 1e4 (arbitrary choice)
    const gasPriceScalingFactor = 1e4;

    // Check that there's no significant underflow when applying
    // this to the exchange rate:
    const adjustedExchangeRate = newExchangeRate.div(gasPriceScalingFactor);
    const recoveredExchangeRate = adjustedExchangeRate.times(
      gasPriceScalingFactor,
    );
    // Ensure we recover at least 99% of the original exchange rate
    if (recoveredExchangeRate.times(100).div(newExchangeRate).gte(99)) {
      newGasPrice = newGasPrice.times(gasPriceScalingFactor);
      newExchangeRate = adjustedExchangeRate;
    }
  }

  const newGasPriceInteger = newGasPrice.integerValue(BigNumberJs.ROUND_CEIL);
  assert(
    newGasPriceInteger.gt(0),
    'Gas price must be greater than 0, possible loss of precision',
  );

  // Round the (possibly rebalanced) exchange rate to an integer, keeping a
  // floor of 1 so a tiny-but-nonzero rate never collapses to 0.
  let newExchangeRateInteger = newExchangeRate.integerValue(
    BigNumberJs.ROUND_FLOOR,
  );
  if (newExchangeRateInteger.lt(1)) {
    newExchangeRateInteger = new BigNumberJs(1);
  }
  assert(
    newExchangeRateInteger.gt(0),
    `Token exchange rate must be greater than 0, possible loss of precision. Original exchange rate: ${exchangeRate.toString()}`,
  );

  return {
    tokenExchangeRate: newExchangeRateInteger.toFixed(0),
    gasPrice: newGasPriceInteger.toFixed(0),
    tokenDecimals: remoteDecimals,
  };
}
