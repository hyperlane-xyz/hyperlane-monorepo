import { BigNumber, Contract, constants, providers } from 'ethers';

const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

const WARP_ROUTE_ABI = [
  'function quoteTransferRemote(uint32 destination, bytes32 recipient, uint256 amount) external view returns ((address token, uint256 amount)[] quotes)',
];

export interface BridgeQuote {
  fee: BigNumber;
  feeToken: string;
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
  fee = 500,
): Promise<BigNumber> {
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    return amountIn;
  }

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

/**
 * Get the bridge fee for a warp route transfer.
 * Calls quoteTransferRemote on the warp route contract.
 */
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
