import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import type { Address, Hex } from 'viem';

import {
  type AnyQuoteV2Entry,
  type FeeQuotingCommand,
  type FeeQuotingQuoteResponse,
  NoQuoteAvailableReason,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { QuoteMode } from '../config.js';
import { ApiError, NoQuoteAvailableError } from '../middleware/errorHandler.js';

import type { EvmQuoteService } from './evmQuoteService.js';
import type {
  IProtocolQuoteService,
  IgpQuoteRequest,
  QuoteBinding,
  WarpQuoteRequest,
} from './IProtocolQuoteService.js';

export interface QuoteServiceOptions {
  /**
   * Typed handle to the EVM service. v1 (`/quote/*`) calls `getV1Quotes` on
   * this directly — `getV1Quotes` is EVM-only and intentionally not on
   * `IProtocolQuoteService`.
   */
  evm: EvmQuoteService;
  /**
   * Per-protocol services for v2 dispatch. The caller is responsible for
   * including the EVM service here too so v2 EVM requests resolve.
   */
  services: ReadonlyMap<ProtocolType, IProtocolQuoteService>;
  /** Chain name → protocol. Populated at startup from the warp configs. */
  protocolByChain: ReadonlyMap<string, ProtocolType>;
  quoteMode: QuoteMode;
  quoteExpiry: number;
  multiProvider: MultiProvider;
  logger: Logger;
  quotesServed?: Counter<string>;
}

/** Default transient buffer in seconds (5 minutes for testing). */
const DEFAULT_TRANSIENT_BUFFER_SECONDS = 300;

/**
 * Thin orchestrator. Per-protocol concrete services own their full stack —
 * artifact reading, per-route state, signing. This class just routes
 * incoming requests to the right service.
 *
 * v1 `/quote/*` is EVM-only by contract and talks to `EvmQuoteService`
 * directly via the typed handle. v2 `/v2/quote/*` dispatches by origin
 * chain's protocol through the `services` map — adding a new protocol means
 * dropping its service into the map at construction, no code change here.
 */
export class QuoteService {
  private readonly evm: EvmQuoteService;
  private readonly services: ReadonlyMap<ProtocolType, IProtocolQuoteService>;
  private readonly protocolByChain: ReadonlyMap<string, ProtocolType>;
  private readonly quoteMode: QuoteMode;
  private readonly quoteExpiry: number;
  private readonly multiProvider: MultiProvider;
  private readonly logger: Logger;
  private readonly quotesServed?: Counter<string>;

  constructor(options: QuoteServiceOptions) {
    this.evm = options.evm;
    this.services = options.services;
    this.protocolByChain = options.protocolByChain;
    this.quoteMode = options.quoteMode;
    this.quoteExpiry = options.quoteExpiry;
    this.multiProvider = options.multiProvider;
    this.logger = options.logger;
    this.quotesServed = options.quotesServed;
  }

  get signerAddress(): Address {
    return this.evm.signerAddress;
  }

  // ============ v1: legacy `/quote/*` endpoints ============

  async getQuote(
    origin: string,
    command: FeeQuotingCommand,
    router: Address,
    destination: number,
    salt: Hex,
    recipient?: Hex,
    targetRouter?: Hex,
  ): Promise<FeeQuotingQuoteResponse> {
    const protocol = this.protocolByChain.get(origin);
    if (!protocol) {
      throw new ApiError(`Unknown origin chain: ${origin}`, 400);
    }
    if (protocol !== ProtocolType.Ethereum) {
      throw new ApiError('v1 quotes are EVM-only', 400);
    }

    const binding = this.buildBinding(salt);
    const destChainName = this.multiProvider.getChainName(destination);

    const quotes = await this.evm.getV1Quotes({
      command,
      origin,
      destChainName,
      destination,
      router,
      recipient,
      targetRouter,
      binding,
    });

    const dest = String(destination);
    for (const q of quotes) {
      this.quotesServed?.inc({
        origin,
        command,
        router,
        destination: dest,
        quoter: q.quoter,
      });
    }

    this.logger.info(
      {
        origin,
        command,
        router,
        destination,
        quoters: quotes.map((q) => q.quoter),
        mode: this.quoteMode,
      },
      'Generated v1 signed quotes',
    );

    return { quotes };
  }

  // ============ v2: `/v2/quote/*` endpoints ============

  async getWarpQuoteV2(args: {
    origin: string;
    router: string;
    destination: number;
    salt: Hex;
    recipient: Hex;
    targetRouter: Hex;
  }): Promise<AnyQuoteV2Entry> {
    const service = this.dispatch(args.origin);
    const req: WarpQuoteRequest = {
      origin: args.origin,
      router: args.router,
      destChainName: this.multiProvider.getChainName(args.destination),
      destination: args.destination,
      recipient: args.recipient,
      targetRouter: args.targetRouter,
      binding: this.buildBinding(args.salt),
    };
    return service.getWarpQuote(req);
  }

  async getIgpQuoteV2(args: {
    origin: string;
    router: string;
    destination: number;
    salt: Hex;
  }): Promise<AnyQuoteV2Entry> {
    const service = this.dispatch(args.origin);
    const req: IgpQuoteRequest = {
      origin: args.origin,
      router: args.router,
      destChainName: this.multiProvider.getChainName(args.destination),
      destination: args.destination,
      sender: args.router,
      binding: this.buildBinding(args.salt),
    };
    return service.getIgpQuote(req);
  }

  // ============ helpers ============

  private dispatch(origin: string): IProtocolQuoteService {
    const protocol = this.protocolByChain.get(origin);
    if (!protocol) {
      throw new ApiError(`Unknown origin chain: ${origin}`, 400);
    }
    const service = this.services.get(protocol);
    if (!service) {
      throw new NoQuoteAvailableError(
        NoQuoteAvailableReason.NotConfigured,
        `Protocol ${protocol} not configured for offchain quoting`,
      );
    }
    return service;
  }

  private buildBinding(salt: Hex): QuoteBinding {
    return this.quoteMode === QuoteMode.TRANSIENT
      ? {
          kind: QuoteMode.TRANSIENT,
          salt,
          transientBuffer: DEFAULT_TRANSIENT_BUFFER_SECONDS,
        }
      : { kind: QuoteMode.STANDING, salt, ttlSeconds: this.quoteExpiry };
  }
}
