import { BigNumber, Contract, constants, providers } from 'ethers';

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
  /** ETH msg fee (native gas for interchain message) */
  fee: BigNumber;
  feeToken: string;
  /** Token fee the bridge charges on top of the transfer amount */
  bridgeTokenFee: BigNumber;
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

  // quoteTransferRemote returns: [ethMsgFee, totalTokenPull, ...].
  // totalTokenPull = amount + bridgeInternalFee, so bridgeTokenFee = totalTokenPull - amount.
  let bridgeTokenFee = BigNumber.from(0);
  if (quotes.length > 1) {
    const tokenPull = quotes[1];
    if (
      tokenPull &&
      tokenPull.token.toLowerCase() !== constants.AddressZero.toLowerCase() &&
      tokenPull.amount.gt(amount)
    ) {
      bridgeTokenFee = tokenPull.amount.sub(amount);
    }
  }

  return {
    fee: feeQuote?.amount ?? BigNumber.from(0),
    feeToken: feeQuote?.token ?? constants.AddressZero,
    bridgeTokenFee,
  };
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
