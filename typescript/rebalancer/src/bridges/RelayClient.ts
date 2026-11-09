import { z } from 'zod';

import { assert } from '@hyperlane-xyz/utils';

import { fetchWithDeadline } from '../utils/fetchWithDeadline.js';

export const RELAY_API_URL = 'https://api.relay.link';
const REQUEST_TIMEOUT_MS = 30_000;

export const RelayAddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const RelayHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const AmountSchema = z.string().regex(/^[0-9]+$/);

export enum RelayTradeType {
  ExactInput = 'EXACT_INPUT',
  ExactOutput = 'EXACT_OUTPUT',
}

export enum RelayStepId {
  Approve = 'approve',
  Deposit = 'deposit',
}

export enum RelayStatus {
  Waiting = 'waiting',
  Depositing = 'depositing',
  Pending = 'pending',
  Submitted = 'submitted',
  Success = 'success',
  Failure = 'failure',
  Refund = 'refund',
}

const CurrencyAmountSchema = z.object({
  currency: z.object({
    chainId: z.number().int().positive(),
    address: RelayAddressSchema,
    decimals: z.number().int().min(0).max(255),
  }),
  amount: AmountSchema,
  minimumAmount: AmountSchema,
});

const TransactionSchema = z.object({
  from: RelayAddressSchema,
  to: RelayAddressSchema,
  data: z.string().regex(/^0x(?:[0-9a-fA-F]{2}){4,}$/),
  value: AmountSchema,
  chainId: z.number().int().positive(),
});

export const RelayQuoteResponseSchema = z.object({
  requestId: RelayHashSchema,
  steps: z
    .array(
      z.object({
        id: z.enum(RelayStepId),
        kind: z.literal('transaction'),
        requestId: RelayHashSchema,
        depositAddress: z.string().optional(),
        items: z.array(z.object({ data: TransactionSchema })).length(1),
      }),
    )
    .min(1)
    .max(2),
  details: z.object({
    sender: RelayAddressSchema,
    recipient: RelayAddressSchema,
    currencyIn: CurrencyAmountSchema,
    currencyOut: CurrencyAmountSchema,
    timeEstimate: z.number().nonnegative(),
    // Costs are already included in the amount received. Keep the breakdown for diagnostics.
    expandedPriceImpact: z
      .record(z.string(), z.object({ usd: z.string() }))
      .optional(),
  }),
});

export type RelayQuoteResponse = z.infer<typeof RelayQuoteResponseSchema>;

export const RelayStatusResponseSchema = z.object({
  status: z.enum(RelayStatus),
  originChainId: z.number().int().positive().optional(),
  destinationChainId: z.number().int().positive().optional(),
  inTxHashes: z.array(RelayHashSchema).optional(),
  txHashes: z.array(RelayHashSchema).optional(),
  failReason: z.string().nullish(),
  refundFailReason: z.string().nullish(),
});

export type RelayStatusResponse = z.infer<typeof RelayStatusResponseSchema>;

export interface RelayQuoteRequest {
  user: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: string;
  tradeType: RelayTradeType;
  slippageTolerance: string;
}

export interface RelayClientConfig {
  apiUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
}

export class RelayRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`Relay HTTP ${status}${code ? ` (${code})` : ''}`);
    this.name = 'RelayRequestError';
  }
}

/** Bounded, unsigned Relay requests. Execution never follows API-provided URLs. */
export class RelayClient {
  private readonly apiUrl: string;

  constructor(private readonly config: RelayClientConfig = {}) {
    const url = new URL(config.apiUrl ?? RELAY_API_URL);
    assert(url.protocol === 'https:', 'Relay API URL must use HTTPS');
    assert(
      !url.username && !url.password && !url.search && !url.hash,
      'Invalid Relay API URL',
    );
    this.apiUrl = url.href.replace(/\/$/, '');
  }

  async quote(request: RelayQuoteRequest): Promise<RelayQuoteResponse> {
    return RelayQuoteResponseSchema.parse(
      await this.request('/quote/v2', {
        method: 'POST',
        body: JSON.stringify({
          ...request,
          refundTo: request.user,
          explicitDeposit: true,
          latePaymentSlippageTolerance: '0',
          usePermit: false,
          useDepositAddress: false,
          useMulticallAuthorization: false,
        }),
      }),
    );
  }

  async getStatus(requestId: string): Promise<RelayStatusResponse> {
    RelayHashSchema.parse(requestId);
    return RelayStatusResponseSchema.parse(
      await this.request(
        `/intents/status/v3?${new URLSearchParams({ requestId })}`,
        { method: 'GET' },
      ),
    );
  }

  private request(path: string, init: RequestInit): Promise<unknown> {
    return fetchWithDeadline(
      `${this.apiUrl}${path}`,
      {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey ? { 'x-api-key': this.config.apiKey } : {}),
        },
      },
      this.config.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      async (response) => {
        if (!response.ok) {
          const body: unknown = await response.json();
          const error = z
            .object({
              code: z.string().optional(),
              errorCode: z.string().optional(),
            })
            .safeParse(body);
          throw new RelayRequestError(
            response.status,
            error.success
              ? (error.data.code ?? error.data.errorCode)
              : undefined,
          );
        }
        return response.json();
      },
    );
  }
}
