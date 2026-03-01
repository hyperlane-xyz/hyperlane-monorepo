import { eqAddress, isZeroishAddress } from '@hyperlane-xyz/utils';
import { BigNumber, Contract, constants, providers } from 'ethers';

import {
  DEFAULT_DEX_FLAVOR,
  DEFAULT_POOL_PARAM,
  DexFlavor,
  getDexFlavorIsUni,
  normalizePoolParam,
} from './types.js';

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const WARP_ROUTE_ABI = [
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) external view returns ((address token, uint256 amount)[] quotes)',
];

const ICA_ROUTER_ABI = [
  'function quoteGasForCommitReveal(uint32 _destinationDomain, uint256 _gasLimit) external view returns (uint256)',
  'function quoteGasPayment(uint32 _destinationDomain, uint256 _gasLimit) external view returns (uint256)',
];

export interface BridgeQuote {
  fee: BigNumber;
  feeToken: string;
  tokenPull: BigNumber;
  tokenPullToken: string;
  bridgeTokenFee: BigNumber;
}

export interface WarpRouteQuote {
  token: string;
  amount: BigNumber;
}

export interface SwapQuoteOptions {
  poolParam?: number;
  dexFlavor?: DexFlavor;
}

function resolveSwapQuoteOptions(
  poolParamOrOptions: number | SwapQuoteOptions,
): { poolParam: number; dexFlavor: DexFlavor } {
  if (typeof poolParamOrOptions === 'number') {
    return {
      poolParam: normalizePoolParam(poolParamOrOptions),
      dexFlavor: DEFAULT_DEX_FLAVOR,
    };
  }

  return {
    poolParam: normalizePoolParam(
      poolParamOrOptions.poolParam ?? DEFAULT_POOL_PARAM,
    ),
    dexFlavor: poolParamOrOptions.dexFlavor ?? DEFAULT_DEX_FLAVOR,
  };
}

export function parseBridgeQuoteTransferRemoteQuotes(
  quotes: WarpRouteQuote[],
  amount: BigNumber,
  bridgeToken?: string,
): BridgeQuote {
  const nativeFee = quotes.reduce((sum, quote) => {
    return isZeroishAddress(quote.token) ? sum.add(quote.amount) : sum;
  }, BigNumber.from(0));

  const tokenQuoteTotals = quotes.reduce<Map<string, WarpRouteQuote>>(
    (aggregated, quote) => {
      if (isZeroishAddress(quote.token)) return aggregated;
      const key = quote.token.toLowerCase();
      const existing = aggregated.get(key);
      if (existing) {
        existing.amount = existing.amount.add(quote.amount);
      } else {
        aggregated.set(key, { token: quote.token, amount: quote.amount });
      }
      return aggregated;
    },
    new Map<string, WarpRouteQuote>(),
  );

  const tokenQuotes = Array.from(tokenQuoteTotals.values());
  const matchingTokenQuote = bridgeToken
    ? tokenQuotes.find((quote) => eqAddress(quote.token, bridgeToken))
    : undefined;

  const tokenPullQuote =
    matchingTokenQuote ??
    tokenQuotes.reduce<WarpRouteQuote | undefined>((max, quote) => {
      if (!max) return quote;
      return quote.amount.gt(max.amount) ? quote : max;
    }, undefined);

  const tokenPull = tokenPullQuote?.amount ?? BigNumber.from(0);
  const bridgeTokenFee = tokenPull.gt(amount)
    ? tokenPull.sub(amount)
    : BigNumber.from(0);

  return {
    fee: nativeFee,
    feeToken: constants.AddressZero,
    tokenPull,
    tokenPullToken: tokenPullQuote?.token ?? constants.AddressZero,
    bridgeTokenFee,
  };
}

/**
 * Get a swap quote from a Uniswap V3 QuoterV2 contract.
 * Returns the expected output amount for a given input.
 */
export async function getSwapQuote(
  provider: providers.Provider,
  quoterAddress: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: BigNumber,
  poolParamOrOptions: number | SwapQuoteOptions = DEFAULT_POOL_PARAM,
): Promise<BigNumber> {
  if (eqAddress(tokenIn, tokenOut)) {
    return amountIn;
  }

  const { poolParam, dexFlavor } = resolveSwapQuoteOptions(poolParamOrOptions);
  const isUni = getDexFlavorIsUni(dexFlavor);

  const quoter = new Contract(quoterAddress, QUOTER_V2_ABI, provider);
  const quoteRequest = {
    tokenIn,
    tokenOut,
    amountIn,
    fee: poolParam,
    sqrtPriceLimitX96: 0,
  };

  const quote = isUni
    ? await quoter.callStatic.quoteExactInputSingle(quoteRequest)
    : await quoter.callStatic.quoteExactInputSingle(quoteRequest);

  return quote.amountOut;
}

/**
 * Get the bridge fee for a warp route transfer.
 * Calls quoteTransferRemote on the warp route contract.
 */
export async function getBridgeFee(
  provider: providers.Provider,
  warpRouteAddress: string,
  destination: number,
  amount: BigNumber,
  bridgeToken?: string,
  recipient = constants.HashZero,
): Promise<BridgeQuote> {
  const warpRoute = new Contract(warpRouteAddress, WARP_ROUTE_ABI, provider);
  const quotes: WarpRouteQuote[] =
    await warpRoute.callStatic.quoteTransferRemote(
      destination,
      recipient,
      amount,
    );
  return parseBridgeQuoteTransferRemoteQuotes(quotes, amount, bridgeToken);
}

/**
 * Quote the native fee for an ICA commit-reveal dispatch (EXECUTE_CROSS_CHAIN).
 * Uses quoteGasForCommitReveal(uint32,uint256) when available and falls back to
 * quoteGasPayment(uint32,uint256) for older routers.
 */
export async function getIcaFee(
  provider: providers.Provider,
  icaRouterAddress: string,
  destinationDomain: number,
  gasLimit = 50_000,
): Promise<BigNumber> {
  const router = new Contract(icaRouterAddress, ICA_ROUTER_ABI, provider);
  try {
    return await router.callStatic.quoteGasForCommitReveal(
      destinationDomain,
      gasLimit,
    );
  } catch {
    return router.callStatic.quoteGasPayment(destinationDomain, gasLimit);
  }
}
