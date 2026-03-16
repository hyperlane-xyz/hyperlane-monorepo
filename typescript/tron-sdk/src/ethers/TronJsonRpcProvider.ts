import { BigNumber, providers } from 'ethers';

import { retryAsync } from '@hyperlane-xyz/utils';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_MS = 250;

/** TronWeb's maximum allowed originEnergyLimit for contract creation. */
export const MAX_TRON_ORIGIN_ENERGY_LIMIT = 10_000_000;

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
  public host: string;
  private maxRetries: number;
  private baseRetryMs: number;

  constructor(
    host: string,
    network?: providers.Networkish,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseRetryMs = DEFAULT_BASE_RETRY_MS,
  ) {
    super(host, network);
    this.host = host;
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
   * Tron's eth_estimateGas doesn't support contract creation (missing `to` field).
   * For deployments, return a default gas limit since Tron uses feeLimit (not gasLimit)
   * for actual execution. For regular calls, delegate to the RPC.
   */
  async estimateGas(
    transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
    if (!transaction.to) {
      // Contract creation — use max feeLimit / gasPrice as a safe default.
      // TronWallet.buildTransaction caps feeLimit at 1000 TRX anyway.
      return BigNumber.from(MAX_TRON_ORIGIN_ENERGY_LIMIT);
    }
    return super.estimateGas(transaction);
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
   * Tron doesn't support ENS - return the name as-is.
   */
  async resolveName(name: string): Promise<string> {
    return name;
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
