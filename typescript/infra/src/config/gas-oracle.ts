import { BigNumber as BigNumberJs } from 'bignumber.js';
import { BigNumber } from 'ethers';

import {
  ChainGasOracleParams,
  ChainMap,
  ChainName,
  GasPriceConfig,
  ProtocolAgnositicGasOracleConfig,
  StorageGasOracleConfig,
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

import { getChain } from '../../config/registry.js';
import { mustGetChainNativeToken } from '../utils/utils.js';

// gas oracle configs for each chain, which includes
// a map for each chain's remote chains
export type AllStorageGasOracleConfigs = ChainMap<
  ChainMap<StorageGasOracleConfig>
>;

// Overcharge by 50% to account for market making risk
export const EXCHANGE_RATE_MARGIN_PCT = 50;

// Arbitrarily chosen as a typical amount of gas used in a message's handle function.
// Used for determining typical gas costs for a message.
export const TYPICAL_HANDLE_GAS_USAGE = 50_000;

// Gets the StorageGasOracleConfig for each remote chain for a particular local chain.
// Accommodates small non-integer gas prices by scaling up the gas price
// and scaling down the exchange rate by the same factor.
function getLocalStorageGasOracleConfigOverride(
  local: ChainName,
  remotes: ChainName[],
  tokenPrices: ChainMap<string>,
  gasPrices: ChainMap<GasPriceConfig>,
  getOverhead: (local: ChainName, remote: ChainName) => number,
  applyMinUsdCost: boolean,
): ChainMap<StorageGasOracleConfig> {
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

  const getTypicalUsdQuote = (
    local: ChainName,
    remote: ChainName,
    gasOracleConfig: ProtocolAgnositicGasOracleConfig,
  ): number => {
    const typicalRemoteGasAmount = getTypicalRemoteGasAmount(
      local,
      remote,
      getOverhead,
    );
    const localTokenUsdPrice = parseFloat(tokenPrices[local]);
    return getUsdQuote(
      localTokenUsdPrice,
      localExchangeRateScale,
      localNativeTokenDecimals,
      localProtocolType,
      gasOracleConfig,
      typicalRemoteGasAmount,
    );
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
    getTypicalUsdQuote,
  });
}

export function getTypicalRemoteGasAmount(
  local: ChainName,
  remote: ChainName,
  getOverhead: (local: ChainName, remote: ChainName) => number,
): number {
  return getOverhead(local, remote) + TYPICAL_HANDLE_GAS_USAGE;
}

function getMinUsdCost(local: ChainName, remote: ChainName): number {
  // By default, min cost is 20 cents
  let minUsdCost = 0.2;

  // For Ethereum local, min cost is 1.5 USD
  if (local === 'ethereum') {
    minUsdCost = Math.max(minUsdCost, 1.5);
  }

  // For all SVM chains, min cost is 0.50 USD to cover rent needs
  if (getChain(remote).protocol === ProtocolType.Sealevel) {
    minUsdCost = Math.max(minUsdCost, 0.5);
  }

  const remoteMinCostOverrides: ChainMap<number> = {
    ethereum: 0.5,

    // For Ethereum L2s, we need to account for the L1 DA costs that
    // aren't accounted for directly in the gas price.
    arbitrum: 0.5,
    ancient8: 0.5,
    blast: 0.5,
    bob: 0.5,
    linea: 0.5,
    mantapacific: 0.5,
    mantle: 0.5,
    polygonzkevm: 0.5,

    // op stack chains
    base: 0.5,
    fraxtal: 0.2,
    lisk: 0.2,
    mode: 0.2,
    optimism: 0.5,
    soneium: 0.2,
    superseed: 0.2,
    unichain: 0.2,

    // Scroll is more expensive than the rest due to higher L1 fees
    scroll: 1.5,
    taiko: 0.5,
    // Nexus adjustment
    neutron: 0.5,
    // For Solana, special min cost
    solanamainnet: 1.2,
    bsc: 0.5,
  };
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
export function getOverhead(
  local: ChainName,
  remote: ChainName,
  ethereumChainNames: ChainName[],
): number {
  return ethereumChainNames.includes(remote as any)
    ? multisigIsmVerificationCost(
        defaultMultisigConfigs[local].threshold,
        defaultMultisigConfigs[local].validators.length,
      )
    : FOREIGN_DEFAULT_OVERHEAD; // non-ethereum overhead
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
