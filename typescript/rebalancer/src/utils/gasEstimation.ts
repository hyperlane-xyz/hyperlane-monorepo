import { BigNumber } from 'ethers';
import type { Logger } from 'pino';

import {
  type AnnotatedEV5Transaction,
  type ChainName,
  type MultiProvider,
  type Token,
  TokenStandard,
} from '@hyperlane-xyz/sdk';
import { addBufferToGasLimit } from '@hyperlane-xyz/utils';

/**
 * Fallback gas limit for transferRemote when eth_estimateGas fails.
 * Conservative estimate for cross-chain token transfers.
 */
export const FALLBACK_TRANSFER_REMOTE_GAS_LIMIT = 300_000n;

/**
 * Cost multiplier for minimum viable transfer.
 * A transfer must be worth at least this multiple of its cost to be worthwhile.
 */
export const MIN_VIABLE_COST_MULTIPLIER = 2n;

/**
 * Transfer cost estimate for native token transfers.
 * Contains all cost components needed for transfer decisions.
 */
export interface TransferCostEstimate {
  /** IGP cost for the Hyperlane message */
  igpCost: bigint;
  /** Estimated gas cost for the transferRemote transaction (with buffer) */
  gasCost: bigint;
  /** Total cost = igpCost + gasCost */
  totalCost: bigint;
  /** Maximum transferable amount after reserving costs (availableInventory - totalCost) */
  maxTransferable: bigint;
  /** Minimum viable transfer (totalCost * MIN_VIABLE_COST_MULTIPLIER) */
  minViableTransfer: bigint;
  /** Gas quote from adapter (for passing to executeTransferRemote) */
  gasQuote?: {
    igpQuote: { amount: bigint };
  };
}

/**
 * Estimate gas for a transferRemote transaction using eth_estimateGas.
 * Falls back to conservative estimate if estimation fails.
 *
 * @param originChain - Chain where transferRemote will be called
 * @param destinationChain - Chain where the Hyperlane message goes
 * @param amount - Amount to transfer
 * @param multiProvider - MultiProvider for chain access
 * @param warpCoreMultiProvider - MultiProvider from WarpCore for adapter access
 * @param getTokenForChain - Function to get token for a chain
 * @param inventorySigner - Address of the inventory signer
 * @param logger - Logger instance
 * @returns Estimated gas limit for the transaction
 */
export async function estimateTransferRemoteGas(
  originChain: ChainName,
  destinationChain: ChainName,
  amount: bigint,
  multiProvider: MultiProvider,
  warpCoreMultiProvider: any,
  getTokenForChain: (chain: ChainName) => Token | undefined,
  inventorySigner: string,
  logger: Logger,
): Promise<bigint> {
  const originToken = getTokenForChain(originChain);
  if (!originToken) {
    logger.warn(
      { originChain },
      'No token found for origin chain, using fallback gas limit',
    );
    return FALLBACK_TRANSFER_REMOTE_GAS_LIMIT;
  }

  try {
    const destinationDomain = multiProvider.getDomainId(destinationChain);
    const adapter = originToken.getHypAdapter(warpCoreMultiProvider);

    // Quote the IGP gas first (needed for the full transaction)
    const gasQuote = await adapter.quoteTransferRemoteGas({
      destination: destinationDomain,
      sender: inventorySigner,
      recipient: inventorySigner,
      amount,
    });

    // Populate with minimal amount for gas estimation
    // Gas cost is independent of transfer size (just a require check in _transferFromSender),
    // and using minimal amount prevents eth_estimateGas from failing when account balance < requested amount
    // Note: getHypAdapter returns IHypTokenAdapter<unknown> for protocol-agnostic support.
    // For EVM chains (which inventory rebalancing uses), the actual type is AnnotatedEV5Transaction.
    const populatedTx = (await adapter.populateTransferRemoteTx({
      destination: destinationDomain,
      recipient: inventorySigner,
      weiAmountOrId: 1n,
      interchainGas: gasQuote,
    })) as AnnotatedEV5Transaction;

    // Estimate gas using the provider
    const provider = multiProvider.getProvider(originChain);
    const gasEstimate = await provider.estimateGas({
      to: populatedTx.to,
      data: populatedTx.data,
      value: populatedTx.value,
      from: inventorySigner,
    });

    const estimatedGas = BigInt(gasEstimate.toString());

    logger.debug(
      {
        originChain,
        destinationChain,
        amount: amount.toString(),
        estimatedGas: estimatedGas.toString(),
      },
      'Estimated transferRemote gas via eth_estimateGas',
    );

    return estimatedGas;
  } catch (error) {
    logger.warn(
      {
        originChain,
        destinationChain,
        error: (error as Error).message,
        fallbackGas: FALLBACK_TRANSFER_REMOTE_GAS_LIMIT.toString(),
      },
      'Gas estimation failed, using fallback gas limit',
    );
    return FALLBACK_TRANSFER_REMOTE_GAS_LIMIT;
  }
}

/**
 * Calculate all transfer costs for a transferRemote operation.
 * Consolidates IGP costs, gas costs, and derived values (max transferable, min viable).
 *
 * @param originChain - Chain to transfer from (where transferRemote is called)
 * @param destinationChain - Chain to transfer to (Hyperlane message destination)
 * @param availableInventory - Available token balance on origin chain
 * @param requestedAmount - Requested transfer amount
 * @param multiProvider - MultiProvider for chain access
 * @param warpCoreMultiProvider - MultiProvider from WarpCore for adapter access
 * @param getTokenForChain - Function to get token for a chain
 * @param inventorySigner - Address of the inventory signer
 * @param isNativeTokenStandard - Function to check if token standard is native
 * @param logger - Logger instance
 * @returns Cost estimate with all components and derived values
 */
export async function calculateTransferCosts(
  originChain: ChainName,
  destinationChain: ChainName,
  availableInventory: bigint,
  requestedAmount: bigint,
  multiProvider: MultiProvider,
  warpCoreMultiProvider: any,
  getTokenForChain: (chain: ChainName) => Token | undefined,
  inventorySigner: string,
  isNativeTokenStandard: (standard: TokenStandard) => boolean,
  logger: Logger,
): Promise<TransferCostEstimate> {
  const originToken = getTokenForChain(originChain);
  if (!originToken) {
    throw new Error(`No token found for origin chain: ${originChain}`);
  }

  const destinationDomain = multiProvider.getDomainId(destinationChain);
  const adapter = originToken.getHypAdapter(warpCoreMultiProvider);

  // Always quote IGP for the gas quote (needed for populateTransferRemoteTx)
  const gasQuote = await adapter.quoteTransferRemoteGas({
    destination: destinationDomain,
    sender: inventorySigner,
    recipient: inventorySigner,
    amount: requestedAmount,
  });

  // For non-native tokens, no cost reservation needed from token balance
  if (!isNativeTokenStandard(originToken.standard)) {
    return {
      igpCost: 0n,
      gasCost: 0n,
      totalCost: 0n,
      maxTransferable:
        availableInventory < requestedAmount
          ? availableInventory
          : requestedAmount,
      minViableTransfer: 0n,
      gasQuote,
    };
  }

  // For native tokens, calculate costs
  const igpCost = gasQuote.igpQuote.amount;

  // Estimate gas with buffer
  const estimatedGasLimit = await estimateTransferRemoteGas(
    originChain,
    destinationChain,
    requestedAmount,
    multiProvider,
    warpCoreMultiProvider,
    getTokenForChain,
    inventorySigner,
    logger,
  );
  const bufferedGasLimit = addBufferToGasLimit(
    BigNumber.from(estimatedGasLimit.toString()),
  );

  // Get gas price and calculate cost
  const provider = multiProvider.getProvider(originChain);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
  const gasCost = bufferedGasLimit.toBigInt() * BigInt(gasPrice.toString());

  const totalCost = igpCost + gasCost;

  // Calculate derived values
  let maxTransferable: bigint;
  if (availableInventory <= totalCost) {
    maxTransferable = 0n;
  } else {
    const maxAfterReservation = availableInventory - totalCost;
    maxTransferable =
      maxAfterReservation < requestedAmount
        ? maxAfterReservation
        : requestedAmount;
  }

  const minViableTransfer = totalCost * MIN_VIABLE_COST_MULTIPLIER;

  logger.debug(
    {
      originChain,
      destinationChain,
      availableInventory: availableInventory.toString(),
      requestedAmount: requestedAmount.toString(),
      igpCost: igpCost.toString(),
      gasCost: gasCost.toString(),
      totalCost: totalCost.toString(),
      maxTransferable: maxTransferable.toString(),
      minViableTransfer: minViableTransfer.toString(),
    },
    'Calculated transfer costs for native token',
  );

  return {
    igpCost,
    gasCost,
    totalCost,
    maxTransferable,
    minViableTransfer,
    gasQuote,
  };
}
