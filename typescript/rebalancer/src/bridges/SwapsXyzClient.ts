import type { Logger } from 'pino';

const DEFAULT_API_URL = 'https://api-v2.swaps.xyz/api';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

/**
 * Error returned by the swaps.xyz API.
 *
 * The `code` field is the machine-readable error label from the API error
 * envelope and is used to decide whether a request should be retried.
 */
export class SwapsXyzRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly statusText: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SwapsXyzRequestError';
  }
}

export const TERMINAL_ERROR_CODES = new Set<string>([
  'INVALID_API_KEY',
  'MISSING_API_KEY',
  'GEO_BLOCKED',
  'WALLET_SCREENED',
  'NO_AVAILABLE_ROUTE',
  'INSUFFICIENT_LIQUIDITY',
  'AMOUNT_TOO_HIGH',
  'AMOUNT_TOO_LOW',
  'INVALID_PARAMETER',
  'INVALID_AMOUNT_ZERO',
  'INVALID_ADDRESS_FORMAT',
  'INVALID_SOURCE_TOKEN',
  'INVALID_DESTINATION_TOKEN',
  'MISSING_REQUIRED_FIELD',
  'CROSS_VM_RECEIVER_REQUIRED',
  'EXCESSIVE_FEE',
  'UNSUPPORTED_NETWORK',
  'UNSUPPORTED_NETWORK_PAIR',
  'UNSUPPORTED_NETWORK_TOKEN_PAIR',
  'UNSUPPORTED_SWAP_DIRECTION',
]);

export function isSwapsXyzTerminalError(error: unknown): boolean {
  if (!(error instanceof SwapsXyzRequestError)) return false;
  if (error.code && TERMINAL_ERROR_CODES.has(error.code)) return true;
  if (error.status === 408) return false;
  return error.status >= 400 && error.status < 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export type SwapsXyzVmId = 'evm' | 'solana' | 'alt-vm' | 'hypercore';
export type SwapsXyzStatus =
  | 'success'
  | 'pending'
  | 'failed'
  | 'refunded'
  | 'requires refund'
  | 'submitted'
  | 'expired'
  | 'not yet created'
  | 'completed';

export interface SwapsXyzEvmTx {
  to: string;
  data: string;
  value: string;
  chainId?: number;
}

export interface SwapsXyzSolanaTx {
  base64Tx: string;
  recentBlockhash?: string;
  payer?: string;
  chainId?: number;
}

export function isEvmTx(tx: unknown): tx is SwapsXyzEvmTx {
  return (
    isRecord(tx) && typeof tx.to === 'string' && typeof tx.data === 'string'
  );
}

export function isSolanaTx(tx: unknown): tx is SwapsXyzSolanaTx {
  return isRecord(tx) && typeof tx.base64Tx === 'string';
}

export interface SwapsXyzTokenAmount {
  amount: string;
  decimals?: number;
  chainId?: number;
  address?: string;
}

export interface SwapsXyzPayment {
  amount: string;
  token?: {
    chainId: number;
    address: string;
    decimals?: number;
    symbol?: string;
  };
  usdAmount?: number;
}

export interface SwapsXyzBridgeRouteHop {
  srcChainId: number;
  dstChainId: number;
  srcBridgeToken: string;
  dstBridgeToken: string;
  bridgeId: string;
}

export interface SwapsXyzActionResponse {
  tx: SwapsXyzEvmTx | SwapsXyzSolanaTx;
  txId: string;
  vmId: SwapsXyzVmId;
  amountIn: SwapsXyzTokenAmount;
  amountInMax?: SwapsXyzTokenAmount;
  amountOut: SwapsXyzTokenAmount;
  amountOutMin: SwapsXyzTokenAmount;
  protocolFee?: SwapsXyzPayment;
  applicationFee?: SwapsXyzPayment;
  bridgeFee?: SwapsXyzPayment;
  bridgeIds?: string[];
  bridgeRoute?: SwapsXyzBridgeRouteHop[];
  exchangeRate?: number;
  estimatedTxTime?: number;
  estimatedPriceImpact?: number;
  requiresTokenApproval: boolean;
  requiresRegisterTransaction?: boolean;
  executionsType?: 'DEFAULT' | 'GASLESS';
}

export interface SwapsXyzActionRequest {
  actionType: 'swap-action';
  sender: string;
  srcChainId: number;
  srcToken: string;
  dstChainId: number;
  dstToken: string;
  slippage: number;
  amount?: string;
  swapDirection?: 'exact-amount-in' | 'exact-amount-out';
  recipient?: string;
}

export interface SwapsXyzStatusRequest {
  txId?: string;
  txHash?: string;
  chainId?: number;
}

export interface SwapsXyzStatusResponse {
  status: SwapsXyzStatus;
  txId: string;
  srcChainId: number;
  dstChainId: number;
  srcTxHash?: string;
  dstTxHash?: string;
  sender?: string;
  bridgeDetails?: {
    isBridge: boolean;
    bridgeTime?: number;
    txPath?: Array<{
      chainId: number;
      txHash: string;
      timestamp?: string;
      nextBridge?: string;
    }>;
  };
  actionResponse?: SwapsXyzActionResponse;
}

export interface SwapsXyzRegisterTxEntry {
  txId: string;
  txHash: string;
}

export interface SwapsXyzRegisterTxResult {
  success: boolean;
  error: string | null;
}

export interface SwapsXyzClientConfig {
  apiKey: string;
  apiUrl?: string;
  defaultSlippageBps?: number;
  requestTimeoutMs?: number;
}

export class SwapsXyzClient {
  readonly logger: Logger;
  readonly defaultSlippageBps: number;
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(config: SwapsXyzClientConfig, logger: Logger) {
    this.apiKey = config.apiKey;
    this.apiUrl = (config.apiUrl ?? DEFAULT_API_URL).replace(/\/$/, '');
    this.defaultSlippageBps = config.defaultSlippageBps ?? 50;
    this.requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
    this.logger = logger;
  }

  getAction(req: SwapsXyzActionRequest): Promise<SwapsXyzActionResponse> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(req)) {
      if (value === undefined || value === null) continue;
      query.set(key, String(value));
    }
    return this.withRetry(() =>
      this.request<SwapsXyzActionResponse>(
        `${this.apiUrl}/getAction?${query.toString()}`,
        { method: 'GET' },
      ),
    );
  }

  getStatus(req: SwapsXyzStatusRequest): Promise<SwapsXyzStatusResponse> {
    if (!req.txHash && !req.txId) {
      throw new Error('getStatus requires either txHash or txId');
    }
    const query = new URLSearchParams();
    if (req.txHash) query.set('txHash', req.txHash);
    if (req.txId) query.set('txId', req.txId);
    if (req.chainId !== undefined) query.set('chainId', String(req.chainId));
    return this.withRetry(() =>
      this.request<SwapsXyzStatusResponse>(
        `${this.apiUrl}/getStatus?${query.toString()}`,
        { method: 'GET' },
      ),
    );
  }

  registerTxs(
    entries: SwapsXyzRegisterTxEntry[],
  ): Promise<SwapsXyzRegisterTxResult[]> {
    return this.withRetry(() =>
      this.request<SwapsXyzRegisterTxResult[]>(`${this.apiUrl}/registerTxs`, {
        method: 'POST',
        body: JSON.stringify(entries),
        headers: { 'content-type': 'application/json' },
      }),
    );
  }

  private async request<T>(
    url: string,
    init: { method: string; body?: string; headers?: Record<string, string> },
  ): Promise<T> {
    const response = await globalThis.fetch(url, {
      method: init.method,
      headers: {
        'x-api-key': this.apiKey,
        ...init.headers,
      },
      body: init.body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) {
      let code: string | undefined;
      let message = `${init.method} ${url} failed: ${response.status} ${response.statusText}`;
      try {
        const body: unknown = await response.json();
        if (isRecord(body) && isRecord(body.error)) {
          if (typeof body.error.code === 'string') code = body.error.code;
          if (typeof body.error.message === 'string') {
            message = `${message}: ${body.error.message}`;
          }
        }
      } catch {
        // Keep the status-derived error when the response is not JSON.
      }
      throw new SwapsXyzRequestError(
        message,
        response.status,
        response.statusText,
        code,
      );
    }
    return response.json();
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (isSwapsXyzTerminalError(lastError)) {
          this.logger.debug(
            { error: lastError.message },
            'swaps.xyz terminal error — not retrying',
          );
          throw lastError;
        }
        this.logger.warn(
          { attempt, error: lastError.message },
          'swaps.xyz request failed, retrying',
        );
        if (attempt < MAX_RETRIES - 1) {
          await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }
    if (lastError) throw lastError;
    throw new Error('swaps.xyz request failed without an error');
  }
}
