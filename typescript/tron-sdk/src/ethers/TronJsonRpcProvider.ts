import { BigNumber, providers } from 'ethers';

import { retryAsync } from '@hyperlane-xyz/utils';

import { stripCustomRpcHeaders } from './urlUtils.js';

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
export class TronJsonRpcProvider extends providers.StaticJsonRpcProvider {
  public host: string;
  private maxRetries: number;
  private baseRetryMs: number;

  constructor(
    host: string,
    network?: providers.Networkish,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseRetryMs = DEFAULT_BASE_RETRY_MS,
  ) {
    const { url: cleanUrl, headers } = stripCustomRpcHeaders(host);
    const hasHeaders = Object.keys(headers).length > 0;
    super(hasHeaders ? { url: cleanUrl, headers } : cleanUrl, network);
    this.host = host;
    this.maxRetries = maxRetries;
    this.baseRetryMs = baseRetryMs;
  }

  /**
   * Override network detection to handle Tron nodes that don't support eth_chainId.
   * Falls back to a default network if detection fails.
   */
  async detectNetwork(): Promise<providers.Network> {
    try {
      return await super.detectNetwork();
    } catch {
      // TRE/TronGrid may not support eth_chainId reliably.
      // Return a default network to avoid blocking all RPC calls.
      return { name: 'tron', chainId: 728126428 };
    }
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
   * Tron's eth_estimateGas is unreliable — it rejects contract creation (no `to` field)
   * and often returns "method parameters invalid" for contract calls.
   * Return a default gas limit since Tron uses feeLimit (not gasLimit) for execution,
   * and TronWallet.buildTransaction caps feeLimit at 1000 TRX anyway.
   */
  async estimateGas(
    _transaction: providers.TransactionRequest,
  ): Promise<BigNumber> {
    try {
      return await super.estimateGas(_transaction);
    } catch {
      // Return a default gas limit for Tron transactions since estimation is unreliable.
      return BigNumber.from(MAX_TRON_ORIGIN_ENERGY_LIMIT);
    }
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
