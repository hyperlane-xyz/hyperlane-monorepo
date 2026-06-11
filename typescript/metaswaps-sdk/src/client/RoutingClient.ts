import type { z } from 'zod';
import { DEFAULT_ROUTING_URL } from '../utils/constants.js';
import {
  ChainsResponseSchema,
  HealthResponseSchema,
  QuoteResponseSchema,
  QuoteRequestSchema,
  ReadinessResponseSchema,
  TokensResponseSchema,
  type ChainsResponse,
  type QuoteRequest,
  type QuoteResponse,
  type ReadinessResponse,
  type TokensQuery,
  type TokensResponse,
} from './schemas.js';

export { DEFAULT_ROUTING_URL };

export class RoutingClient {
  constructor(private readonly baseUrl: string = DEFAULT_ROUTING_URL) {}

  async health(): Promise<boolean> {
    try {
      const body = await this.get('/health', HealthResponseSchema);
      return body.ok;
    } catch {
      return false;
    }
  }

  readiness(): Promise<ReadinessResponse> {
    return this.get('/readyz', ReadinessResponseSchema);
  }

  chains(): Promise<ChainsResponse> {
    return this.get('/v1/chains', ChainsResponseSchema);
  }

  tokens(query: TokensQuery = {}): Promise<TokensResponse> {
    const params = new URLSearchParams();
    if (query.ids?.length) {
      for (const id of query.ids) params.append('ids', id);
    } else {
      if (query.chain != null) params.set('chain', String(query.chain));
      if (query.search) params.set('search', query.search);
    }
    const qs = params.toString();
    return this.get(`/v1/tokens${qs ? `?${qs}` : ''}`, TokensResponseSchema);
  }

  async quote(params: QuoteRequest): Promise<QuoteResponse> {
    const validated = QuoteRequestSchema.parse(params);
    const res = await fetch(`${this.baseUrl}/v1/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...validated,
        // bigint → string for JSON serialization
        amount: String(validated.amount),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Quote request failed (${res.status}): ${text}`);
    }
    const json = await res.json();
    return QuoteResponseSchema.parse(json);
  }

  private async get<S extends z.ZodTypeAny>(
    path: string,
    schema: S,
  ): Promise<z.infer<S>> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      throw new Error(`GET ${path} failed (${res.status}): ${res.statusText}`);
    }
    const json = await res.json();
    return schema.parse(json);
  }
}
