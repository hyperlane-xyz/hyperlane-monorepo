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

function isZeroAddress(token: string): boolean {
  return token.toLowerCase() === constants.AddressZero.toLowerCase();
}

export function parseBridgeQuoteTransferRemoteQuotes(
  quotes: WarpRouteQuote[],
  amount: BigNumber,
  bridgeToken?: string,
): BridgeQuote {
  const nativeFeeQuote = quotes.find((quote) => isZeroAddress(quote.token));
  const tokenQuotes = quotes.filter((quote) => !isZeroAddress(quote.token));

  const matchingTokenQuote = bridgeToken
    ? tokenQuotes.find(
        (quote) => quote.token.toLowerCase() === bridgeToken.toLowerCase(),
      )
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
    fee: nativeFeeQuote?.amount ?? BigNumber.from(0),
    feeToken: nativeFeeQuote?.token ?? constants.AddressZero,
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
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
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
): Promise<BridgeQuote> {
  const warpRoute = new Contract(warpRouteAddress, WARP_ROUTE_ABI, provider);
  const quotes: WarpRouteQuote[] =
    await warpRoute.callStatic.quoteTransferRemote(
      destination,
      constants.HashZero,
      amount,
    );
  return parseBridgeQuoteTransferRemoteQuotes(quotes, amount, bridgeToken);
}

/**
 * Quote the native fee for an ICA dispatch (EXECUTE_CROSS_CHAIN).
 * Calls quoteGasPayment(uint32,uint256) on the origin ICA router.
 */
export async function getIcaFee(
  provider: providers.Provider,
  icaRouterAddress: string,
  destinationDomain: number,
  gasLimit = 50_000,
): Promise<BigNumber> {
  const router = new Contract(icaRouterAddress, ICA_ROUTER_ABI, provider);
  return router.quoteGasPayment(destinationDomain, gasLimit);
}
