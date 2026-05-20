import type { Logger } from 'pino';
import type { Counter } from 'prom-client';
import type { Address, Hex } from 'viem';

import {
  type AnyQuoteV2Entry,
  type DerivedTokenRouterConfig,
  type FeeQuotingCommand,
  type FeeQuotingQuoteResponse,
  type MultiProvider,
} from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { QuoteMode } from '../config.js';
import { ApiError } from '../middleware/errorHandler.js';

import { EvmQuoteService } from './evmQuoteService.js';
import type {
  IgpQuoteRequest,
  QuoteBinding,
  WarpQuoteRequest,
} from './IProtocolQuoteService.js';
import { ProtocolSignerRegistry } from './protocolSignerRegistry.js';

/**
 * Per-router config derived from on-chain state. Discriminated by `protocol`.
 */
export type RouterQuoteContext = EvmRouterQuoteContext | SvmRouterQuoteContext;

export interface EvmRouterQuoteContext {
  protocol: ProtocolType.Ethereum;
  chainId: number;
  quotedCallsAddress: Address;
  feeToken: Address;
  derivedConfig: DerivedTokenRouterConfig;
}

/**
 * Sealevel router context — the warp token's program ID plus the discovered
 * fee/IGP sub-contexts (each carries the resolved on-chain PDA address used
 * in the signed message hash, and the raw artifact for per-route signer
 * lookups). Either sub-context may be absent if the token isn't configured
 * for that quoter.
 */
export interface SvmRouterQuoteContext {
  protocol: ProtocolType.Sealevel;
  /** Origin chain's Hyperlane domain id (appears in the signed message hash). */
  domainId: number;
  /** Base58 program ID of the warp token. */
  warpProgramId: string;
  fee?: SvmFeeQuoterContext;
  igp?: SvmIgpQuoterContext;
}

export interface SvmFeeQuoterContext {
  /** Fee program ID (base58). */
  programId: string;
  /** On-chain `fee_account` PDA — appears in the signed message hash. */
  feeAccountPda: string;
}

export interface SvmIgpQuoterContext {
  /** IGP program ID (base58). */
  programId: string;
  /** On-chain `igp_account` PDA — appears in the signed message hash. */
  igpAccountPda: string;
}

/**
 * Per-chain context grouping a chain's routers. Discriminated by `protocol`.
 */
export type ChainQuoteContext = EvmChainQuoteContext | SvmChainQuoteContext;

export interface EvmChainQuoteContext {
  protocol: ProtocolType.Ethereum;
  chainName: string;
  quotedCallsAddress: Address;
  /** Keys are router addresses normalized to lowercase. */
  routers: Map<string, EvmRouterQuoteContext>;
}

export interface SvmChainQuoteContext {
  protocol: ProtocolType.Sealevel;
  chainName: string;
  domainId: number;
  /** Keys are warp program IDs (base58 — no lowercase normalization). */
  routers: Map<string, SvmRouterQuoteContext>;
}

export interface QuoteServiceOptions {
  signerKey: Hex;
  quoteMode: QuoteMode;
  quoteExpiry: number;
  multiProvider: MultiProvider;
  chainContexts: Map<string, ChainQuoteContext>;
  logger: Logger;
  quotesServed?: Counter<string>;
}

/** Default transient buffer in seconds (5 minutes for testing). */
const DEFAULT_TRANSIENT_BUFFER_SECONDS = 300;

/**
 * Orchestrates protocol-dispatched quote production. Per-protocol signing
 * (EVM EIP-712, SVM raw keccak256) lives behind `IProtocolQuoteService`. v1
 * `/quote/*` is EVM-only and reuses the EVM signer's dedicated `getV1Quotes`
 * entry point; v2 `/v2/quote/*` dispatches through the registry.
 */
export class QuoteService {
  private readonly evmSigner: EvmQuoteService;
  private readonly signers: ProtocolSignerRegistry;
  private readonly quoteMode: QuoteMode;
  private readonly quoteExpiry: number;
  private readonly multiProvider: MultiProvider;
  private readonly chainContexts: Map<string, ChainQuoteContext>;
  private readonly logger: Logger;
  private readonly quotesServed?: Counter<string>;

  constructor(options: QuoteServiceOptions) {
    this.evmSigner = new EvmQuoteService({
      signerKey: options.signerKey,
      logger: options.logger,
    });
    this.signers = new ProtocolSignerRegistry(
      new Map([[ProtocolType.Ethereum, this.evmSigner]]),
    );
    this.quoteMode = options.quoteMode;
    this.quoteExpiry = options.quoteExpiry;
    this.multiProvider = options.multiProvider;
    this.chainContexts = options.chainContexts;
    this.logger = options.logger;
    this.quotesServed = options.quotesServed;
  }

  get signerAddress(): Address {
    return this.evmSigner.signerAddress;
  }

  getChainContext(origin: string): ChainQuoteContext | undefined {
    return this.chainContexts.get(origin);
  }

  // ============ v1: legacy `/quote/*` endpoints ============

  /**
   * Generate signed quotes for a QuotedCalls command. EVM-only by v1's
   * contract; non-EVM origins error out.
   */
  async getQuote(
    origin: string,
    command: FeeQuotingCommand,
    router: Address,
    destination: number,
    salt: Hex,
    recipient?: Hex,
    targetRouter?: Hex,
  ): Promise<FeeQuotingQuoteResponse> {
    const routerCtx = this.lookupRouter(origin, router);
    if (routerCtx.protocol !== ProtocolType.Ethereum) {
      throw new ApiError('v1 quotes are EVM-only', 400);
    }

    const binding = this.buildBinding(salt);
    const destChainName = this.multiProvider.getChainName(destination);

    const quotes = await this.evmSigner.getV1Quotes({
      command,
      origin,
      routerCtx,
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

  /**
   * Produce a single warp/token-fee quote (`/v2/quote/warp`). Throws
   * `NoQuoteAvailableError` (404) when the signer can't produce one.
   */
  async getWarpQuoteV2(args: {
    origin: string;
    router: string;
    destination: number;
    salt: Hex;
    recipient: Hex;
    targetRouter: Hex;
  }): Promise<AnyQuoteV2Entry> {
    const routerCtx = this.lookupRouter(args.origin, args.router);
    const binding = this.buildBinding(args.salt);
    const destChainName = this.multiProvider.getChainName(args.destination);
    const req: WarpQuoteRequest = {
      routerCtx,
      destChainName,
      destination: args.destination,
      recipient: args.recipient,
      targetRouter: args.targetRouter,
      binding,
    };
    return this.signers.forProtocol(routerCtx.protocol).getWarpQuote(req);
  }

  /**
   * Produce a single IGP quote (`/v2/quote/igp`). Throws
   * `NoQuoteAvailableError` (404) when the signer can't produce one.
   */
  async getIgpQuoteV2(args: {
    origin: string;
    router: string;
    destination: number;
    salt: Hex;
  }): Promise<AnyQuoteV2Entry> {
    const routerCtx = this.lookupRouter(args.origin, args.router);
    const binding = this.buildBinding(args.salt);
    const destChainName = this.multiProvider.getChainName(args.destination);
    const req: IgpQuoteRequest = {
      routerCtx,
      destChainName,
      destination: args.destination,
      sender: args.router,
      binding,
    };
    return this.signers.forProtocol(routerCtx.protocol).getIgpQuote(req);
  }

  // ============ helpers ============

  private lookupRouter(origin: string, router: string): RouterQuoteContext {
    const ctx = this.chainContexts.get(origin);
    if (!ctx) throw new ApiError(`Unknown origin chain: ${origin}`, 400);
    const routerCtx = ctx.routers.get(router.toLowerCase());
    if (!routerCtx) {
      throw new ApiError(`Unknown router ${router} on ${origin}`, 400);
    }
    return routerCtx;
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
