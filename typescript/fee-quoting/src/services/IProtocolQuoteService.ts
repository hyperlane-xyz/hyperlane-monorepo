import type { Hex } from 'viem';

import type { AnyQuoteV2Entry } from '@hyperlane-xyz/sdk';
import type { ProtocolType } from '@hyperlane-xyz/provider-sdk';

import { QuoteMode } from '../config.js';

/**
 * Label for which quoter a signed quote applies to. Shared across protocol
 * implementations so error messages and skip logs use the same vocabulary for
 * the warp/token-fee quoter vs the IGP quoter.
 */
export const QuoterType = {
  WarpFee: 'warp fee',
  Igp: 'IGP',
} as const;

export type QuoterType = (typeof QuoterType)[keyof typeof QuoterType];

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

/**
 * Inputs for a warp/token-fee quote. The service looks up its own per-route
 * state by `(origin, router)`; protocol-specific data (derived config, fee
 * account PDA, signers, etc.) is encapsulated inside the service.
 *
 * `txSubmitter` is the address that will submit the resulting signed quote
 * on-chain.
 *   - EVM: typically the `QuotedCalls` contract (transient) or `address(0)`
 *     (standing). Current EVM impl ignores the value and derives it from
 *     the server's `quoteMode` + the route's `quotedCallsAddress`.
 *   - SVM: the end-user's wallet pubkey. Used as `payer` in
 *     `scoped_salt = keccak256(payer ‖ client_salt)` for the signed message
 *     hash — required since SVM has no `QuotedCalls`-equivalent wrapper
 *     program to pin a known submitter at startup.
 */
export interface WarpQuoteRequest {
  origin: string;
  /** Origin warp router (EVM hex address OR SVM base58 program ID). */
  router: string;
  destChainName: string;
  destination: number;
  recipient: Hex;
  /**
   * Destination warp router (bytes32 hex). Always supplied by v2 callers; the
   * signer impl decides whether it enters the signed bytes (CC routes yes,
   * non-CC no).
   */
  targetRouter: Hex;
  /** On-chain submitter of the resulting quote (see interface JSDoc). */
  txSubmitter: string;
  binding: QuoteBinding;
}

/** Inputs for an IGP quote. Same route-lookup semantics as `WarpQuoteRequest`. */
export interface IgpQuoteRequest {
  origin: string;
  /** Origin warp router (EVM hex address OR SVM base58 program ID). */
  router: string;
  destChainName: string;
  destination: number;
  /** Origin warp router (EVM hex address OR SVM base58 pubkey) — used as the
   *  `sender` field in the IGP context bytes. Often equal to `router`. */
  sender: string;
  /** On-chain submitter of the resulting quote (see `WarpQuoteRequest` JSDoc). */
  txSubmitter: string;
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
