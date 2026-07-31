import { BigNumber, providers } from 'ethers';
import { TronWeb } from 'tronweb';

import { ensure0x, retryAsync } from '@hyperlane-xyz/utils';

import { buildTronTriggerRequest } from '../utils/index.js';
import { stripCustomRpcHeaders, toHttpApiUrl } from './urlUtils.js';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_RETRY_MS = 250;

/** Raw full-node `wallet/triggerconstantcontract` request payload. */
interface TronConstantCallArgs {
  owner_address: string;
  contract_address: string;
  function_selector: string;
  data?: string;
  call_value: number;
  visible: boolean;
}

/** Subset of the raw full-node constant-call response we read. */
interface TronConstantCallResponse {
  constant_result?: string[];
  result?: { result?: boolean; message?: string };
}

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
  private tronWeb: TronWeb;

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
    this.tronWeb = new TronWeb({
      fullHost: toHttpApiUrl(host),
      headers,
    });
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
    // Route contract reads through the raw constant-call endpoint (see
    // callContract): some public Tron RPCs (e.g. TronGrid, Alchemy) don't
    // answer eth_call reliably.
    if (method === 'call' && params.blockTag === 'latest') {
      return this.callContract(params.transaction);
    }

    return retryAsync(
      () => super.perform(method, params),
      this.maxRetries,
      this.baseRetryMs,
    );
  }

  private async callContract(
    transaction: providers.TransactionRequest,
  ): Promise<string> {
    const { contractAddress, callValue, input, issuerAddress } =
      buildTronTriggerRequest(this.tronWeb, transaction, transaction.from);
    const args: TronConstantCallArgs = {
      owner_address: issuerAddress,
      contract_address: contractAddress,
      function_selector: '',
      data: input,
      call_value: callValue,
      visible: false,
    };
    // Post directly to the raw constant-call endpoint instead of TronWeb's
    // triggerConstantContract wrapper, which throws on a reverted read and
    // discards constant_result. eth_call returns the reverted/empty data, and
    // the ISM null-config probe that mirrors eth_call needs that data (0x on an
    // empty return) so ethers can recognize a missing selector. A genuine
    // transport failure still rejects and propagates.
    const response = await retryAsync(
      () =>
        this.tronWeb.fullNode.request<TronConstantCallResponse>(
          'wallet/triggerconstantcontract',
          args,
          'post',
        ),
      this.maxRetries,
      this.baseRetryMs,
    );
    return ensure0x(response.constant_result?.[0] ?? '');
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
