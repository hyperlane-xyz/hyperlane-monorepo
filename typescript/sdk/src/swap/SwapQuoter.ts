import { Contract, BigNumber, constants, providers } from 'ethers';

import {
  BridgeQuote,
  SwapAndBridgeParams,
  SwapQuote,
  TotalQuote,
} from './types.js';

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const WARP_ROUTE_ABI = [
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) external view returns ((address token, uint256 amount)[] quotes)',
];

export const QUOTER_ADDRESSES = {
  arbitrum: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  base: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
};

function resolveQuoterAddress(chainId: number): string {
  if (chainId === 42161) return QUOTER_ADDRESSES.arbitrum;
  if (chainId === 8453) return QUOTER_ADDRESSES.base;
  throw new Error(`Unsupported chainId ${chainId} for QuoterV2`);
}

function toRate(amountIn: BigNumber, amountOut: BigNumber): string {
  if (amountIn.isZero()) return '0';
  return amountOut.mul(constants.WeiPerEther).div(amountIn).toString();
}

function slippageBps(slippage: number): number {
  return Math.max(0, Math.floor(slippage * 100));
}

export async function getSwapQuote(
  provider: providers.Provider,
  tokenIn: string,
  tokenOut: string,
  amountIn: BigNumber,
  fee = 500,
): Promise<BigNumber> {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

  const network = await provider.getNetwork();
  const quoterAddress = resolveQuoterAddress(network.chainId);
  const quoter = new Contract(quoterAddress, QUOTER_V2_ABI, provider);
  const quote = await quoter.callStatic.quoteExactInputSingle({
    tokenIn,
    tokenOut,
    amountIn,
    fee,
    sqrtPriceLimitX96: 0,
  });

  return quote.amountOut;
}

export async function getBridgeFee(
  provider: providers.Provider,
  warpRouteAddress: string,
  destination: number,
  amount: BigNumber,
): Promise<BridgeQuote> {
  const warpRoute = new Contract(warpRouteAddress, WARP_ROUTE_ABI, provider);
  const quotes: Array<{ token: string; amount: BigNumber }> =
    await warpRoute.callStatic.quoteTransferRemote(
      destination,
      constants.HashZero,
      amount,
    );
  const feeQuote = quotes[0];

  return {
    fee: feeQuote?.amount ?? BigNumber.from(0),
    feeToken: feeQuote?.token ?? constants.AddressZero,
  };
}

export async function getTotalQuote(
  quoteProviders: {
    origin: providers.Provider;
    destination: providers.Provider;
  },
  params: SwapAndBridgeParams,
): Promise<TotalQuote> {
  const originSwapOutput = await getSwapQuote(
    quoteProviders.origin,
    params.originToken,
    params.bridgeToken,
    params.amount,
  );

  const bridge = await getBridgeFee(
    quoteProviders.origin,
    params.warpRouteAddress,
    params.destinationDomain,
    originSwapOutput,
  );

  const bridgedAmount = originSwapOutput.sub(bridge.fee);

  const destinationSwapOutput = await getSwapQuote(
    quoteProviders.destination,
    params.bridgeToken,
    params.destinationToken,
    bridgedAmount,
  );

  const estimatedOutput = destinationSwapOutput;
  const minimumReceived = estimatedOutput
    .mul(10_000 - slippageBps(params.slippage))
    .div(10_000);

  const quote: SwapQuote = {
    originSwapOutput,
    originSwapRate: toRate(params.amount, originSwapOutput),
    bridgeFee: bridge.fee,
    destinationSwapOutput,
    destinationSwapRate: toRate(bridgedAmount, destinationSwapOutput),
    estimatedOutput,
    minimumReceived,
    slippage: params.slippage,
  };

  return {
    originSwap: quote,
    bridge,
    estimatedOutput,
    minimumReceived,
  };
}
