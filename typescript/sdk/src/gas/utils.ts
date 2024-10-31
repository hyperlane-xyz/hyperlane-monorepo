import { Provider } from '@ethersproject/providers';
import { BigNumber, ethers } from 'ethers';

import { ProtocolType, convertDecimals, objMap } from '@hyperlane-xyz/utils';

import {
  TOKEN_EXCHANGE_RATE_DECIMALS,
  TOKEN_EXCHANGE_RATE_SCALE,
} from '../consts/igp.js';
import { ChainMetadataManager } from '../metadata/ChainMetadataManager.js';
import { AgentCosmosGasPrice } from '../metadata/agentConfig.js';
import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { ChainMap, ChainName } from '../types.js';
import { getCosmosRegistryChain } from '../utils/cosmos.js';

import { StorageGasOracleConfig } from './oracle/types.js';

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
    case ProtocolType.Cosmos: {
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
  if (metadata.protocol !== ProtocolType.Cosmos) {
    throw new Error(`Chain ${chain} is not a Cosmos chain`);
  }

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

// Gets the exchange rate of the remote quoted in local tokens
export function getTokenExchangeRateFromValues({
  local,
  remote,
  tokenPrices,
  exchangeRateMarginPct,
  decimals,
}: {
  local: ChainName;
  remote: ChainName;
  tokenPrices: ChainMap<string>;
  exchangeRateMarginPct: number;
  decimals: { local: number; remote: number };
}): BigNumber {
  // Workaround for chicken-egg dependency problem.
  // We need to provide some default value here to satisfy the config on initial load,
  // whilst knowing that it will get overwritten when a script actually gets run.
  const defaultValue = '1';
  const localValue = ethers.utils.parseUnits(
    tokenPrices[local] ?? defaultValue,
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );
  const remoteValue = ethers.utils.parseUnits(
    tokenPrices[remote] ?? defaultValue,
    TOKEN_EXCHANGE_RATE_DECIMALS,
  );

  // This does not yet account for decimals!
  let exchangeRate = remoteValue.mul(TOKEN_EXCHANGE_RATE_SCALE).div(localValue);
  // Apply the premium
  exchangeRate = exchangeRate.mul(100 + exchangeRateMarginPct).div(100);

  return BigNumber.from(
    convertDecimals(decimals.remote, decimals.local, exchangeRate.toString()),
  );
}

// Gets the StorageGasOracleConfig for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
export function getLocalStorageGasOracleConfig({
  local,
  gasOracleParams,
  exchangeRateMarginPct,
}: {
  local: ChainName;
  gasOracleParams: ChainMap<ChainGasOracleParams>;
  exchangeRateMarginPct: number;
}): ChainMap<StorageGasOracleConfig> {
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
    let exchangeRate = getTokenExchangeRateFromValues({
      local,
      remote,
      tokenPrices,
      exchangeRateMarginPct,
      decimals: { local: localDecimals, remote: remoteDecimals },
    });

    // First parse as a number, so we have floating point precision.
    // Recall it's possible to have gas prices that are not integers, even
    // after converting to the "wei" version of the token.
    let gasPrice =
      parseFloat(gasOracleParams[remote].gasPrice.amount) *
      Math.pow(10, gasOracleParams[remote].gasPrice.decimals);
    if (isNaN(gasPrice)) {
      throw new Error(
        `Invalid gas price for chain ${remote}: ${gasOracleParams[remote].gasPrice.amount}`,
      );
    }

    // We have very little precision and ultimately need an integer value for
    // the gas price that will be set on-chain. We scale up the gas price and
    // scale down the exchange rate by the same factor.
    if (gasPrice < 10 && gasPrice % 1 !== 0) {
      // Scale up the gas price by 1e4
      const gasPriceScalingFactor = 1e4;

      // Check that there's no significant underflow when applying
      // this to the exchange rate:
      const adjustedExchangeRate = exchangeRate.div(gasPriceScalingFactor);
      const recoveredExchangeRate = adjustedExchangeRate.mul(
        gasPriceScalingFactor,
      );
      if (recoveredExchangeRate.mul(100).div(exchangeRate).lt(99)) {
        throw new Error('Too much underflow when downscaling exchange rate');
      }

      // Apply the scaling factor
      exchangeRate = adjustedExchangeRate;
      gasPrice *= gasPriceScalingFactor;
    }

    // Our integer gas price.
    const gasPriceBn = BigNumber.from(Math.ceil(gasPrice));

    return {
      ...agg,
      [remote]: {
        tokenExchangeRate: exchangeRate.toString(),
        gasPrice: gasPriceBn.toString(),
      },
    };
  }, {} as ChainMap<StorageGasOracleConfig>);
}

const COINGECKO_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price';

export async function getCoingeckoTokenPrices(
  chainMetadata: ChainMap<ChainMetadata>,
  currency = 'usd',
): Promise<ChainMap<string | undefined>> {
  const ids = objMap(
    chainMetadata,
    (_, metadata) => metadata.gasCurrencyCoinGeckoId ?? metadata.name,
  );

  const resp = await fetch(
    `${COINGECKO_PRICE_API}?ids=${Object.entries(ids).join(
      ',',
    )}&vs_currencies=${currency}`,
  );

  const idPrices = await resp.json();

  const prices = objMap(ids, (chain, id) => {
    const idData = idPrices[id];
    if (!idData) {
      return undefined;
    }
    const price = idData[currency];
    if (!price) {
      return undefined;
    }
    return price.toString();
  });

  return prices;
}
