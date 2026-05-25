import type { Address, Hex } from 'viem';

import type { ProtocolType } from '@hyperlane-xyz/provider-sdk';

/** Command types matching QuotedCalls.sol constants */
export enum QuotedCallsCommand {
  SUBMIT_QUOTE = 0x00,
  PERMIT2_PERMIT = 0x01,
  PERMIT2_TRANSFER_FROM = 0x02,
  TRANSFER_FROM = 0x03,
  TRANSFER_REMOTE = 0x04,
  TRANSFER_REMOTE_TO = 0x05,
  CALL_REMOTE_WITH_OVERRIDES = 0x06,
  CALL_REMOTE_COMMIT_REVEAL = 0x07,
  SWEEP = 0x08,
}

/** Mirrors IOffchainQuoter.SignedQuote struct */
export interface SignedQuoteData {
  context: Hex;
  data: Hex;
  issuedAt: number;
  expiry: number;
  salt: Hex;
  submitter: Address;
}

/** SUBMIT_QUOTE command parameters — matches fee-quoting service response */
export interface SubmitQuoteCommand {
  quoter: Address;
  quote: SignedQuoteData;
  signature: Hex;
}

/** How tokens are pulled into QuotedCalls contract */
export enum TokenPullMode {
  /** Standard ERC20 transferFrom — requires prior approval to QuotedCalls */
  TransferFrom = 'transferFrom',
  /** Permit2 allowance transfer — uses signed permit, no prior approval needed */
  Permit2 = 'permit2',
}

/** Permit2 PermitSingle + signature for PERMIT2_PERMIT command */
export interface Permit2Data {
  permitSingle: {
    details: {
      token: Address;
      amount: bigint;
      expiration: number;
      nonce: number;
    };
    spender: Address;
    sigDeadline: number;
  };
  signature: Hex;
}

/**
 * Fee-paying commands in QuotedCalls that require offchain quotes.
 * String values correspond to the fee-quoting service API routes.
 */
export enum FeeQuotingCommand {
  TransferRemote = 'transferRemote',
  TransferRemoteTo = 'transferRemoteTo',
  CallRemoteWithOverrides = 'callRemoteWithOverrides',
  CallRemoteCommitReveal = 'callRemoteCommitReveal',
}

/** Commands that require a warp fee quote (in addition to IGP) */
export const WARP_FEE_COMMANDS = new Set<FeeQuotingCommand>([
  FeeQuotingCommand.TransferRemote,
  FeeQuotingCommand.TransferRemoteTo,
]);

export interface FeeQuotingQuoteResponse {
  quotes: SubmitQuoteCommand[];
}

// ============================================================
// v2 fee-quoting API types
// ============================================================
//
// v2 splits the v1 endpoint family by quoter type — a single response carries
// one quote from one quoter, with the protocol-specific signing payload nested
// under `details`. The envelope is generic over `(protocol, details)` so new
// VMs are added by introducing a new `*QuoteV2Entry` alias without touching
// existing variants.

/**
 * Protocol-agnostic envelope for an offchain quote returned by the v2 API.
 *
 * - `protocol` discriminates the `details` payload.
 * - `quoter` is the on-chain account whose identity participates in
 *   signed-quote verification:
 *     - EVM: verifying contract address (`OffchainQuotedIGP` /
 *       `OffchainQuotedLinearFee`).
 *     - SVM: fee/IGP program account pubkey (`fee_account` / `igp_account`
 *       — the first non-domain-tag input to `build_message_hash`).
 *   This is NOT the on-chain storage PDA. SVM transient-quote PDA derivation
 *   involves the actual submitter (payer) at on-chain submit time, which the
 *   offchain server has no role in — the client computes that PDA themselves.
 * - `issuedAt` / `expiry` are unix seconds, decoded from each protocol's
 *   native representation (e.g. SVM's u48 BE bytes are decoded to JS numbers
 *   here).
 */
export interface QuoteV2Entry<P extends ProtocolType, D> {
  protocol: P;
  quoter: string;
  issuedAt: number;
  expiry: number;
  details: D;
}

/** EVM signed-quote payload (EIP-712 typed data + secp256k1 signature). */
export interface EthereumQuoteDetails {
  quote: SignedQuoteData;
  signature: Hex;
}

/**
 * SVM signed-quote payload (Borsh `SvmSignedQuote` + secp256k1 signature over
 * a raw `keccak256` digest). `domainId` is the origin chain's Hyperlane
 * domain id; it appears in the message hash and is needed to reconstruct it.
 */
export interface SealevelQuoteDetails {
  domainId: number;
  signedQuote: SealevelSignedQuote;
}

/**
 * Wire shape of the on-chain `SvmSignedQuote` struct, with each byte field
 * exposed as `0x`-prefixed hex for transport. Mirrors the Rust
 * `quote-verifier::SvmSignedQuote`.
 */
export interface SealevelSignedQuote {
  /** Protocol-native context bytes (44B non-CC | 76B CC). */
  context: Hex;
  /** Borsh-encoded `FeeDataStrategy` (Linear / Regressive / Progressive). */
  data: Hex;
  /** 6 bytes (u48 BE). */
  issuedAt: Hex;
  /** 6 bytes (u48 BE). `expiry === issuedAt` ⇒ transient. */
  expiry: Hex;
  /** 32 bytes — client-provided salt for PDA derivation + replay prevention. */
  clientSalt: Hex;
  /** 65 bytes (r:32, s:32, v:1). */
  signature: Hex;
}

export type EthereumQuoteV2Entry = QuoteV2Entry<
  ProtocolType.Ethereum,
  EthereumQuoteDetails
>;

export type SealevelQuoteV2Entry = QuoteV2Entry<
  ProtocolType.Sealevel,
  SealevelQuoteDetails
>;

/**
 * Discriminated union of every known v2 quote variant. Add a new VM by
 * introducing a new `*QuoteV2Entry` alias and adding it here.
 */
export type AnyQuoteV2Entry = EthereumQuoteV2Entry | SealevelQuoteV2Entry;

/** v2 success response: at most one quote per request (404 when unavailable). */
export interface QuoteV2Response {
  quote: AnyQuoteV2Entry;
}

/**
 * Path segments under the v2 quote API. Shared between client + server so
 * that route names stay in lockstep.
 */
export const QuoteV2Endpoint = {
  Warp: 'warp',
  Igp: 'igp',
} as const;
export type QuoteV2Endpoint =
  (typeof QuoteV2Endpoint)[keyof typeof QuoteV2Endpoint];

/** URL prefix every v2 quote endpoint lives under. */
export const QUOTE_V2_BASE_PATH = '/v2/quote';

/** Reasons the server may refuse to produce a quote (404 response). */
export const NoQuoteAvailableReason = {
  NotAuthorized: 'not_authorized',
  NotUpgraded: 'not_upgraded',
  NotConfigured: 'not_configured',
} as const;

export type NoQuoteAvailableReason =
  (typeof NoQuoteAvailableReason)[keyof typeof NoQuoteAvailableReason];

/** The `error` discriminator for `NoQuoteAvailableError` 404 bodies. */
export const NO_QUOTE_AVAILABLE_ERROR = 'no_quote_available';

/**
 * v2 404 response body shape — emitted when the server cannot produce a quote
 * for the requested route/quoter. NOT a JS `Error` class; this is the JSON body.
 */
export interface NoQuoteAvailableError {
  error: typeof NO_QUOTE_AVAILABLE_ERROR;
  reason: NoQuoteAvailableReason;
  detail: string;
}

// ============================================================
// v1 types (unchanged below)
// ============================================================

/** Parameters for building a QuotedCalls transfer via WarpCore */
export interface QuotedCallsParams {
  /** QuotedCalls contract address */
  address: Address;
  /** Signed quotes from fee-quoting service */
  quotes: SubmitQuoteCommand[];
  /** Client salt (pre-scope — QuotedCalls applies keccak256(msg.sender, clientSalt)) */
  clientSalt: Hex;
  /** Token pull strategy */
  tokenPullMode: TokenPullMode;
  /** Required when tokenPullMode === Permit2 */
  permit2Data?: Permit2Data;
  /** Pre-computed fee quotes from getQuotedTransferFee. If provided, skips quoteExecute eth_call. */
  feeQuotes?: Array<Array<{ token: Address; amount: bigint }>>;
}
