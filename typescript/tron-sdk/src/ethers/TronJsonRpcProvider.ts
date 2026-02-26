import { providers } from 'ethers';

import { retryAsync } from '@hyperlane-xyz/utils';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_MS = 250;

/**
 * TronJsonRpcProvider extends ethers JsonRpcProvider for Tron's JSON-RPC API.
 *
 * Tron's JSON-RPC endpoint supports most standard Ethereum JSON-RPC methods,
 * but with a few notable exceptions:
 * - eth_sendRawTransaction: Not supported (must use TronWeb for transactions)
 * - eth_getTransactionCount: Not supported (Tron doesn't use nonces)
 *
 * This provider handles these gaps by returning appropriate defaults
 * and wraps all RPC calls with retry logic to handle transient errors
 * (e.g. TronGrid rate limiting).
 */
export class TronJsonRpcProvider extends providers.JsonRpcProvider {
  public url: string;
  private maxRetries: number;
  private baseRetryMs: number;

  constructor(
    url: string,
    network?: providers.Networkish,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseRetryMs = DEFAULT_BASE_RETRY_MS,
  ) {
    // Ensure we're pointing to the /jsonrpc endpoint
    const jsonRpcUrl = url.endsWith('/jsonrpc') ? url : `${url}/jsonrpc`;
    super(jsonRpcUrl, network);
    this.url = url;
    this.maxRetries = maxRetries;
    this.baseRetryMs = baseRetryMs;
  }

  /**
   * Wraps all RPC calls with retry logic to handle transient
   * errors like 503s from TronGrid rate limiting.
   */
  async perform(method: string, params: any): Promise<any> {
    return retryAsync(
      () => super.perform(method, params),
      this.maxRetries,
      this.baseRetryMs,
    );
  }

  /**
   * Tron doesn't use nonces - always return 0.
   */
  async getTransactionCount(
    _addressOrName: string,
    _blockTag?: providers.BlockTag,
  ): Promise<number> {
    return 0;
  }

  /**
   * Return legacy gas pricing only - Tron doesn't support EIP-1559.
   */
  async getFeeData(): Promise<providers.FeeData> {
    const gasPrice = await this.getGasPrice();
    return {
      gasPrice,
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      lastBaseFeePerGas: null,
    };
  }
}
