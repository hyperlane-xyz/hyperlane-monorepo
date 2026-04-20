import type { Address, Hex } from 'viem';

import type { FeeQuotingCommand, FeeQuotingQuoteResponse } from './types.js';

export interface FeeQuotingClientOptions {
  baseUrl: string;
  apiKey: string;
}

export interface QuoteParams {
  origin: string;
  command: FeeQuotingCommand;
  router: Address;
  destination: number;
  /** Pre-computed salt (e.g. keccak256(sender, clientSalt) for QuotedCalls) */
  salt: Hex;
  /** Required for warp commands (transferRemote, transferRemoteTo) */
  recipient?: Hex;
  /** Target router for transferRemoteTo with CrossCollateralRoutingFee */
  targetRouter?: Hex;
}

export class FeeQuotingClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options: FeeQuotingClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
  }

  async getQuote(params: QuoteParams): Promise<FeeQuotingQuoteResponse> {
    const query = new URLSearchParams({
      origin: params.origin,
      router: params.router,
      destination: String(params.destination),
      salt: params.salt,
    });

    if (params.recipient) query.set('recipient', params.recipient);
    if (params.targetRouter) query.set('targetRouter', params.targetRouter);

    const res = await fetch(
      `${this.baseUrl}/quote/${params.command}?${query}`,
      { headers: { Authorization: `Bearer ${this.apiKey}` } },
    );

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(
        `Fee quoting request failed (${res.status}): ${(body as Record<string, string>).message ?? res.statusText}`,
      );
    }

    return res.json() as Promise<FeeQuotingQuoteResponse>;
  }
}
