import { Provider } from '@ethersproject/providers';
import { BigNumber as BigNumberJs } from 'bignumber.js';
import { BigNumber, ethers } from 'ethers';

import {
  ProtocolType,
  assert,
  convertDecimals,
  objMap,
} from '@hyperlane-xyz/utils';

import { getProtocolExchangeRateDecimals } from '../consts/igp.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { AgentCosmosGasPrice } from '../metadata/agentConfig.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../types.js';
import { getCosmosRegistryChain } from '../utils/cosmos.js';

import { ProtocolAgnositicGasOracleConfig } from './oracle/types.js';

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
  mpp: MultiProtocolProvider,
  chain: string,
): Promise<GasPriceConfig> {
  const protocolType = mpp.getProtocol(chain);
  switch (protocolType) {
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

  // Prioritize the gas price from the metadata, if available.
  if (metadata.gasPrice) {
    return metadata.gasPrice;
  }

  // Use the cosmos registry gas price as a fallback.
  const cosmosRegistryChain = await getCosmosRegistryChain(chain);
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
}): BigNumberJs {
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

function getProtocolExchangeRate(
  localProtocolType: ProtocolType,
  exchangeRate: BigNumberJs,
): BigNumber {
  const multiplierDecimals = getProtocolExchangeRateDecimals(localProtocolType);
  const multiplier = new BigNumberJs(10).pow(multiplierDecimals);
  const integer = exchangeRate
    .times(multiplier)
    .integerValue(BigNumberJs.ROUND_FLOOR)
    .toString(10);
  return BigNumber.from(integer);
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
}: {
  local: ChainName;
  localProtocolType: ProtocolType;
  gasOracleParams: ChainMap<ChainGasOracleParams>;
  exchangeRateMarginPct: number;
  gasPriceModifier?: (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ) => BigNumberJs.Value;
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

    // Make the exchange rate an integer by scaling it up by the appropriate factor for the protocol.
    const exchangeRate = getProtocolExchangeRate(
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
    let gasOracleConfig = adjustForPrecisionLoss(
      gasPrice,
      exchangeRate,
      remoteDecimals,
      remote,
    );

    // Apply the modifier if provided.
    if (gasPriceModifier) {
      // Once again adjust for precision loss after applying the modifier.
      gasOracleConfig = adjustForPrecisionLoss(
        gasPriceModifier(local, remote, gasOracleConfig),
        BigNumber.from(gasOracleConfig.tokenExchangeRate),
        remoteDecimals,
        remote,
      );
    }

    return {
      ...agg,
      [remote]: gasOracleConfig,
    };
  }, {} as ChainMap<ProtocolAgnositicGasOracleConfig>);
}

function adjustForPrecisionLoss(
  gasPrice: BigNumberJs.Value,
  exchangeRate: BigNumber,
  remoteDecimals: number,
  remote?: ChainName,
): ProtocolAgnositicGasOracleConfig {
  let newGasPrice = new BigNumberJs(gasPrice);
  let newExchangeRate = exchangeRate;

  // We may have very little precision, and ultimately need an integer value for
  // the gas price that will be set on-chain. If this is the case, we scale up the
  // gas price and scale down the exchange rate by the same factor.
  if (newGasPrice.lt(10) && newGasPrice.mod(1) !== new BigNumberJs(0)) {
    // Scale up the gas price by 1e4 (arbitrary choice)
    const gasPriceScalingFactor = 1e4;

    // Check that there's no significant underflow when applying
    // this to the exchange rate:
    const adjustedExchangeRate = newExchangeRate.div(gasPriceScalingFactor);
    const recoveredExchangeRate = adjustedExchangeRate.mul(
      gasPriceScalingFactor,
    );
    if (recoveredExchangeRate.mul(100).div(newExchangeRate).lt(99)) {
      throw new Error(
        `Too much underflow when downscaling exchange rate for remote chain ${remote}`,
      );
    }

    newGasPrice = newGasPrice.times(gasPriceScalingFactor);
    newExchangeRate = adjustedExchangeRate;
  }

  const newGasPriceInteger = newGasPrice.integerValue(BigNumberJs.ROUND_CEIL);
  assert(
    newGasPriceInteger.gt(0),
    'Gas price must be greater than 0, possible loss of precision',
  );

  return {
    tokenExchangeRate: newExchangeRate.toString(),
    gasPrice: newGasPriceInteger.toString(),
    tokenDecimals: remoteDecimals,
  };
}
