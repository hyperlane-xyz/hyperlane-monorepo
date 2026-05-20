import type { Hex } from 'viem';

import type { AnyQuoteV2Entry } from '@hyperlane-xyz/sdk';
import type { ProtocolType } from '@hyperlane-xyz/utils';

import { QuoteMode } from '../config.js';

import type { RouterQuoteContext } from './quoteService.js';

/**
 * Salt + expiry binding applied to a signed quote. Protocol-agnostic: the
 * EVM-specific `submitter` (`QuotedCalls` address vs `address(0)`) and the
 * SVM-specific `clientSalt`/PDA mechanics are derived by each signer impl
 * from `kind` + the per-protocol router context. `salt` is the shared client
 * salt (same role for both EVM EIP-712 `salt` and SVM `clientSalt`).
 */
export type QuoteBinding = TransientQuoteBinding | StandingQuoteBinding;

export interface TransientQuoteBinding {
  kind: typeof QuoteMode.TRANSIENT;
  salt: Hex;
  /**
   * Seconds added to `now` for `issuedAt` (= `expiry` in transient mode), to
   * absorb block-time skew when the tx lands.
   */
  transientBuffer: number;
}

export interface StandingQuoteBinding {
  kind: typeof QuoteMode.STANDING;
  salt: Hex;
  /** Standing-quote TTL in seconds. `expiry = now + ttlSeconds`. */
  ttlSeconds: number;
}

/** Inputs for a warp/token-fee quote. */
export interface WarpQuoteRequest {
  routerCtx: RouterQuoteContext;
  destChainName: string;
  destination: number;
  recipient: Hex;
  /**
   * Destination warp router (bytes32 hex). Always supplied by v2 callers; the
   * signer impl decides whether it enters the signed bytes (CC routes yes,
   * non-CC no).
   */
  targetRouter: Hex;
  binding: QuoteBinding;
}

/** Inputs for an IGP quote. */
export interface IgpQuoteRequest {
  routerCtx: RouterQuoteContext;
  destChainName: string;
  destination: number;
  /** Origin warp router (EVM hex address OR SVM base58 pubkey). */
  sender: string;
  binding: QuoteBinding;
}

/**
 * Per-protocol quote production. Each implementation owns resolution
 * (traversing the on-chain config tree) and signing (EIP-712 / raw keccak256)
 * privately; the caller only asks for a warp or IGP quote and gets back a
 * shaped `AnyQuoteV2Entry` or a `NoQuoteAvailableError` (404).
 */
export interface IProtocolQuoteService {
  readonly protocol: ProtocolType;

  /**
   * Produces a warp/token-fee quote for the route. Throws
   * `NoQuoteAvailableError` when the quoter cannot be resolved or this
   * signer's key isn't whitelisted on-chain.
   */
  getWarpQuote(req: WarpQuoteRequest): Promise<AnyQuoteV2Entry>;

  /**
   * Produces an IGP quote for the route. Throws `NoQuoteAvailableError` when
   * the IGP cannot be resolved or this signer's key isn't whitelisted
   * on-chain.
   */
  getIgpQuote(req: IgpQuoteRequest): Promise<AnyQuoteV2Entry>;
}
