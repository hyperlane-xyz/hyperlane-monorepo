import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import type { Address, Hex } from 'viem';

import {
  type AnyQuoteV2Entry,
  type FeeQuotingCommand,
  type FeeQuotingQuoteResponse,
  NoQuoteAvailableReason,
  type MultiProvider,
  QuoteV2Endpoint,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { assert, isEVMLike } from '@hyperlane-xyz/utils';

import { QuoteMode } from '../config.js';
import { ApiError, NoQuoteAvailableError } from '../middleware/errorHandler.js';

import { EvmQuoteService } from './evmQuoteService.js';
import type {
  IProtocolQuoteService,
  IgpQuoteRequest,
  QuoteBinding,
  WarpQuoteRequest,
} from './IProtocolQuoteService.js';

export interface QuoteServiceOptions {
  /**
   * Per-protocol services for v2 dispatch. Must include an `EvmQuoteService`
   * under `ProtocolType.Ethereum` — v1 (`/quote/*`) is EVM-only and reaches
   * `getV1Quotes` on that entry directly (intentionally not on
   * `IProtocolQuoteService`).
   */
  services: ReadonlyMap<ProtocolType, IProtocolQuoteService>;
  /** Chain name → protocol. Populated at startup from the warp configs. */
  protocolByChain: ReadonlyMap<string, ProtocolType>;
  quoteMode: QuoteMode;
  quoteExpiry: number;
  transientBuffer: number;
  multiProvider: MultiProvider;
  logger: Logger;
  quotesServed?: Counter<string>;
}

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
  private readonly transientBuffer: number;
  private readonly multiProvider: MultiProvider;
  private readonly logger: Logger;
  private readonly quotesServed?: Counter<string>;

  constructor(options: QuoteServiceOptions) {
    const evm = options.services.get(ProtocolType.Ethereum);
    assert(
      evm instanceof EvmQuoteService,
      'QuoteService requires an EvmQuoteService under ProtocolType.Ethereum in `services`',
    );
    this.evm = evm;
    this.services = options.services;
    this.protocolByChain = options.protocolByChain;
    this.quoteMode = options.quoteMode;
    this.quoteExpiry = options.quoteExpiry;
    this.transientBuffer = options.transientBuffer;
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
    if (!isEVMLike(protocol)) {
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
    txSubmitter: string;
  }): Promise<AnyQuoteV2Entry> {
    const service = this.dispatch(args.origin);
    const req: WarpQuoteRequest = {
      origin: args.origin,
      router: args.router,
      destChainName: this.multiProvider.getChainName(args.destination),
      destination: args.destination,
      recipient: args.recipient,
      targetRouter: args.targetRouter,
      txSubmitter: args.txSubmitter,
      binding: this.buildBinding(args.salt),
    };
    const entry = await service.getWarpQuote(req);
    this.recordQuoteServed(QuoteV2Endpoint.Warp, args, entry);
    return entry;
  }

  async getIgpQuoteV2(args: {
    origin: string;
    router: string;
    destination: number;
    salt: Hex;
    txSubmitter: string;
  }): Promise<AnyQuoteV2Entry> {
    const service = this.dispatch(args.origin);
    const req: IgpQuoteRequest = {
      origin: args.origin,
      router: args.router,
      destChainName: this.multiProvider.getChainName(args.destination),
      destination: args.destination,
      sender: args.router,
      txSubmitter: args.txSubmitter,
      binding: this.buildBinding(args.salt),
    };
    const entry = await service.getIgpQuote(req);
    this.recordQuoteServed(QuoteV2Endpoint.Igp, args, entry);
    return entry;
  }

  // ============ helpers ============

  /**
   * Increment the `quotes_served` counter and emit a per-quote log line for a
   * v2 quote, mirroring the v1 `getQuote` path so SVM (v2-only) origins are not
   * absent from `hyperlane_fee_quoting_quotes_served_total`. `command` uses the
   * v2 endpoint name (`warp` / `igp`) — v2 has no `FeeQuotingCommand` analogue.
   */
  private recordQuoteServed(
    command: QuoteV2Endpoint,
    args: { origin: string; router: string; destination: number },
    entry: AnyQuoteV2Entry,
  ): void {
    this.quotesServed?.inc({
      origin: args.origin,
      command,
      router: args.router,
      destination: String(args.destination),
      quoter: entry.quoter,
    });

    this.logger.info(
      {
        origin: args.origin,
        command,
        router: args.router,
        destination: args.destination,
        quoter: entry.quoter,
        mode: this.quoteMode,
      },
      'Generated v2 signed quote',
    );
  }

  private dispatch(origin: string): IProtocolQuoteService {
    const protocol = this.protocolByChain.get(origin);
    if (!protocol) {
      throw new ApiError(`Unknown origin chain: ${origin}`, 400);
    }
    // EVM-family chains (Ethereum, Tron, ...) all share the single
    // EvmQuoteService registered under ProtocolType.Ethereum.
    const key = isEVMLike(protocol) ? ProtocolType.Ethereum : protocol;
    const service = this.services.get(key);
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
          transientBuffer: this.transientBuffer,
        }
      : { kind: QuoteMode.STANDING, salt, ttlSeconds: this.quoteExpiry };
  }
}
