import {
  BlockTag,
  FeeData,
  JsonRpcProvider,
  Networkish,
} from 'ethers';
import type { JsonRpcPayload, JsonRpcResult } from 'ethers';

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
 * and wraps raw JSON-RPC transport calls with retry logic to handle
 * transient errors (e.g. TronGrid rate limiting).
 */
export class TronJsonRpcProvider extends JsonRpcProvider {
  public host: string;
  private readonly maxRetries: number;
  private readonly baseRetryMs: number;

  constructor(
    host: string,
    network?: Networkish,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseRetryMs = DEFAULT_BASE_RETRY_MS,
  ) {
    const jsonRpcUrl = host.endsWith('/jsonrpc') ? host : `${host}/jsonrpc`;
    super(jsonRpcUrl, network);
    this.host = host;
    this.maxRetries = maxRetries;
    this.baseRetryMs = baseRetryMs;
  }

  override async _send(
    payload: JsonRpcPayload | Array<JsonRpcPayload>,
  ): Promise<Array<JsonRpcResult>> {
    return retryAsync(
      () => super._send(payload),
      this.maxRetries,
      this.baseRetryMs,
    );
  }

  /**
   * Tron doesn't use nonces - always return 0.
   */
  override async getTransactionCount(
    _addressOrName: string,
    _blockTag?: BlockTag,
  ): Promise<number> {
    return 0;
  }

  /**
   * Tron doesn't support ENS - return the name as-is.
   */
  override async resolveName(name: string): Promise<string> {
    return name;
  }

  /**
   * Return legacy gas pricing only - Tron doesn't support EIP-1559.
   */
  override async getFeeData(): Promise<FeeData> {
    // Avoid ethers v6 block formatting in super.getFeeData(), which can reject
    // Tron JSON-RPC blocks (e.g. empty stateRoot = "0x").
    const gasPriceHex = await this.send('eth_gasPrice', []);
    const gasPrice = typeof gasPriceHex === 'string' ? BigInt(gasPriceHex) : 0n;
    return new FeeData(gasPrice, null, null);
  }
}
