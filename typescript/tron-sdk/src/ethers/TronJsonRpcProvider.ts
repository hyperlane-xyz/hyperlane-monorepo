import { BigNumber, providers, utils } from 'ethers';
import { TronWeb } from 'tronweb';

import { ensure0x, isNullish, retryAsync } from '@hyperlane-xyz/utils';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && !isNullish(value);
}

/** Standard EVM/JSON-RPC "execution reverted" error code. */
const JSON_RPC_REVERT_CODE = 3;

/**
 * Shapes native constant-call reverts as ethers CALL_EXCEPTION errors so the
 * SDK's missing-selector detection (see @hyperlane-xyz/sdk contract utils)
 * recognizes them exactly as it would an eth_call revert.
 */
const callExceptionLogger = new utils.Logger('tron-sdk');

function nextInChain(node: Record<string, unknown>): unknown {
  return node.error ?? node.cause;
}

/**
 * True for ethers' synthetic top-level CALL_EXCEPTION wrapper. For the `call`
 * method, @ethersproject/providers `checkError` wraps EVERY failed eth_call —
 * genuine reverts AND transport failures alike — into a CALL_EXCEPTION carrying
 * `data: "0x"` and the generic reason "missing revert data in call exception",
 * nesting the original error under `.error`. Both cases share this wrapper, so
 * it cannot itself distinguish a revert from a 503 and must be skipped when
 * classifying; the truth lives in the nested original error.
 */
function isSyntheticCallExceptionWrapper(
  node: Record<string, unknown>,
): boolean {
  return (
    node.code === utils.Logger.errors.CALL_EXCEPTION &&
    typeof node.message === 'string' &&
    node.message.includes('missing revert data in call exception')
  );
}

/**
 * True when the error chain positively indicates the VM executed and reverted
 * (including the reasonless / missing-selector case). A reasonless Tron revert
 * surfaces as ethers' CALL_EXCEPTION wrapper over a nested SERVER_ERROR whose
 * message carries "execution reverted" — the SAME code shape as a real 503, so
 * a transport-code scan alone cannot tell them apart. We therefore detect a
 * revert positively, skipping the synthetic wrapper, via any of: a revert
 * message, the JSON-RPC revert code, or non-synthetic hex return data. A revert
 * is re-thrown so the SDK's missing-selector detection sees the CALL_EXCEPTION
 * and JSON-RPC-only proxies never touch the native endpoint.
 */
function isRevertError(error: unknown): boolean {
  let current: unknown = error;
  while (isRecord(current)) {
    if (!isSyntheticCallExceptionWrapper(current)) {
      const messages = [current.message, current.reason, current.body].filter(
        (value): value is string => typeof value === 'string',
      );
      if (messages.some((value) => /revert/i.test(value))) {
        return true;
      }
      if (current.code === JSON_RPC_REVERT_CODE) {
        return true;
      }
      if (typeof current.data === 'string' && current.data.startsWith('0x')) {
        return true;
      }
    }
    current = nextInChain(current);
  }
  return false;
}

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
    const performWithRetry = () =>
      retryAsync(
        () => super.perform(method, params),
        this.maxRetries,
        this.baseRetryMs,
      );

    // Contract reads are eth_call-first: standard JSON-RPC lets ethers surface
    // reverts as CALL_EXCEPTION (which the SDK's missing-selector detection
    // recognizes) and keeps JSON-RPC-only proxies working, since a re-thrown
    // revert never touches the native endpoint. A positively-detected revert is
    // re-thrown; ANY other failure — a transport error (503/timeout) or a node
    // that simply doesn't answer eth_call (e.g. -32601) — falls back to the raw
    // constant-call endpoint (see callContract), as used by public RPCs like
    // TronGrid and Alchemy.
    if (method === 'call' && params.blockTag === 'latest') {
      try {
        return await performWithRetry();
      } catch (error: unknown) {
        if (isRevertError(error)) {
          throw error;
        }
        return this.callContract(params.transaction);
      }
    }

    return performWithRetry();
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
    // discards constant_result.
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
    const { result, constant_result } = response;

    // SUCCESS: the VM executed successfully; its return data lands in
    // constant_result[0] (empty -> 0x). Only a successful execution returns
    // data — a revert must not reach ABI decoding as if it were return data.
    if (result?.result === true) {
      return ensure0x(constant_result?.[0] ?? '');
    }

    // EXECUTED-REVERT: a `constant_result` on a non-success means the VM ran and
    // reverted; its revert bytes land in constant_result[0] (empty -> 0x for a
    // reasonless revert). Surface it as a CALL_EXCEPTION carrying that data so
    // the SDK's missing-selector detection recognizes a reasonless (0x) revert
    // as a missing selector, while a revert WITH data propagates as a real
    // revert — mirroring what ethers' eth_call would surface.
    if (constant_result) {
      const data = ensure0x(constant_result[0] ?? '');
      const rawMessage = result?.message;
      const reason = rawMessage
        ? this.tronWeb.toUtf8(rawMessage)
        : 'execution reverted';
      throw callExceptionLogger.makeError(
        `Tron constant call reverted: ${reason}`,
        utils.Logger.errors.CALL_EXCEPTION,
        { data },
      );
    }

    // PRE-EXECUTION FAILURE: no constant_result means the call failed before
    // execution (bad request, contract not found, disabled API, malformed
    // response). Surface the node's decoded message rather than masking a real
    // failure as an empty return.
    const rawMessage = result?.message;
    const message = rawMessage
      ? this.tronWeb.toUtf8(rawMessage)
      : 'unknown error';
    throw new Error(`Tron constant call failed: ${message}`);
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
