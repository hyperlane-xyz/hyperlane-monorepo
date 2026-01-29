import type { Logger } from 'pino';

/**
 * Configuration for an external bridge.
 */
export interface ExternalBridgeConfig {
  integrator: string; // Required: dApp/company name for bridge integration
  apiKey?: string; // Optional: API key for higher rate limits
  defaultSlippage?: number; // Default slippage tolerance (e.g., 0.005 = 0.5%)
}

/**
 * Parameters for requesting a bridge quote.
 */
export interface BridgeQuoteParams {
  fromChain: number; // Source chain ID
  toChain: number; // Destination chain ID
  fromToken: string; // Source token address
  toToken: string; // Destination token address
  fromAmount: bigint; // Amount to bridge (in token decimals)
  fromAddress: string; // Sender address
  toAddress?: string; // Recipient address (defaults to fromAddress)
  slippage?: number; // Slippage tolerance (overrides default)
}

/**
 * Quote response from a bridge.
 */
export interface BridgeQuote {
  id: string; // Unique quote identifier
  tool: string; // Bridge/DEX tool used (e.g., 'stargate', 'across')
  fromAmount: bigint; // Amount being sent
  toAmount: bigint; // Expected amount to receive
  toAmountMin: bigint; // Minimum amount to receive (after slippage)
  executionDuration: number; // Estimated execution time in seconds
  route: unknown; // Bridge-specific route data for execution
}

/**
 * Result of executing a bridge transfer.
 */
export interface BridgeTransferResult {
  txHash: string; // Origin chain transaction hash
  fromChain: number; // Source chain ID
  toChain: number; // Destination chain ID
  transferId?: string; // Bridge-specific transfer identifier
}

/**
 * Status of a bridge transfer.
 */
export type BridgeTransferStatus =
  | { status: 'pending'; substatus?: string }
  | { status: 'complete'; receivingTxHash: string; receivedAmount: bigint }
  | { status: 'failed'; error?: string }
  | { status: 'not_found' };

/**
 * Interface for external bridge implementations (e.g., LiFi, Socket).
 *
 * External bridges are used for inventory rebalancing when chains don't support
 * MovableCollateralRouter. The flow is:
 * 1. quote() - Get a quote for bridging tokens
 * 2. execute() - Execute the bridge transfer
 * 3. getStatus() - Poll for transfer completion
 */
export interface IExternalBridge {
  readonly bridgeId: string;
  readonly logger: Logger;

  /**
   * Get a quote for bridging tokens between chains.
   */
  quote(params: BridgeQuoteParams): Promise<BridgeQuote>;

  /**
   * Execute a bridge transfer using a previously obtained quote.
   * @param quote - Quote obtained from quote()
   * @param signer - Signer for the transaction (type depends on bridge implementation)
   */
  execute(quote: BridgeQuote, signer: unknown): Promise<BridgeTransferResult>;

  /**
   * Get the status of a bridge transfer.
   * @param txHash - Origin chain transaction hash
   * @param fromChain - Source chain ID
   * @param toChain - Destination chain ID
   */
  getStatus(
    txHash: string,
    fromChain: number,
    toChain: number,
  ): Promise<BridgeTransferStatus>;
}
