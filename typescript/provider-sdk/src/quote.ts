import { type FeeReadContext } from './fee.js';

/**
 * Offchain quote management — cross-VM interfaces.
 *
 * Warp quotes are signed by an authorized off-chain signer and submitted
 * on-chain against a deployed offchain-quoted fee artifact (EVM
 * `OffchainQuotedLinearFee`, SVM `hyperlane-sealevel-fee`, …). Both protocols
 * discriminate transient (`expiry === issuedAt`, ephemeral) from standing
 * (`expiry > issuedAt`, persistent) by the relation of these two timestamps.
 *
 * Warp-specific surface is prefixed with `Warp` / `WARP_` so this file can
 * later host parallel IGP-quote interfaces without name collisions. Signing
 * primitives (`RawQuoteSigner`, `SignableInput`, `QuoteSignature`) stay
 * unprefixed because they are payload-agnostic and reusable across quote
 * domains.
 */

/** uint32::MAX — matches `WILDCARD_DOMAIN` on both EVM and SVM. */
export const WILDCARD_DESTINATION_DOMAIN = 0xff_ff_ff_ff;

/** bytes32 0xFF…FF — matches `WILDCARD_RECIPIENT` on both EVM and SVM. */
export const WILDCARD_BYTES32: string = '0x' + 'f'.repeat(64);

/**
 * bytes32 0x00…00 — "no CC scope" target_router sentinel for warp quotes. On
 * SVM this is the Leaf/Routing standing PDA seed; on EVM the field is ignored.
 */
export const WARP_TARGET_ROUTER_NONE: string = '0x' + '0'.repeat(64);

export const WarpQuoteAmountKind = {
  wildcard: 'wildcard',
  value: 'value',
} as const;
export type WarpQuoteAmountKind =
  (typeof WarpQuoteAmountKind)[keyof typeof WarpQuoteAmountKind];

/**
 * Discriminated union because the wildcard sentinel differs per protocol
 * (`uint256::MAX` on EVM vs `u64::MAX` on SVM) — the cross-VM caller cannot
 * pick the right bigint. Each protocol writer maps `'wildcard'` to its own
 * sentinel.
 */
export type WarpQuoteAmount =
  | { kind: typeof WarpQuoteAmountKind.wildcard }
  | { kind: typeof WarpQuoteAmountKind.value; value: bigint };

export const WARP_QUOTE_AMOUNT_WILDCARD: WarpQuoteAmount = {
  kind: WarpQuoteAmountKind.wildcard,
};

export interface WarpQuoteScope {
  destination: number;
  recipient: string;
  targetRouter: string;
  amount: WarpQuoteAmount;
}

export interface WarpLinearQuoteParams {
  maxFee: bigint;
  halfAmount: bigint;
}

export interface CreateWarpQuoteRequest {
  scope: WarpQuoteScope;
  params: WarpLinearQuoteParams;
  issuedAt: number;
  expiry: number;
}

export interface SubmittedWarpQuote {
  txHash: string;
  signature: string;
}

export interface StandingWarpQuoteEntry {
  scope: WarpQuoteScope;
  params: WarpLinearQuoteParams;
  issuedAt: number;
  expiry: number;
}

/**
 * Opaque cross-VM signable envelope. Each protocol SDK defines its own
 * concrete signable shape and a `parse*Signable(x: unknown): T` parser that
 * its `RawQuoteSigner` implementation calls internally to narrow.
 *
 * Domain-agnostic on purpose — both warp and (future) IGP quote signers
 * accept the same envelope shape and narrow per their on-chain verifier's
 * expectations.
 */
export type SignableInput = Record<string, unknown>;

export interface QuoteSignature {
  signature: Uint8Array;
}

export interface RawQuoteSigner {
  address(): Promise<string>;
  sign(input: SignableInput): Promise<QuoteSignature>;
}

export interface IRawWarpQuoteWriter {
  submitQuote(req: CreateWarpQuoteRequest): Promise<SubmittedWarpQuote>;
}

export interface IRawWarpQuoteReader {
  enumerateCandidates(): Promise<WarpQuoteScope[]>;
  readStandingQuotes(): Promise<StandingWarpQuoteEntry[]>;
}

export interface IRawWarpQuoteArtifactManager {
  createWriter(signer: RawQuoteSigner): IRawWarpQuoteWriter;
  createReader(): IRawWarpQuoteReader;
}

/**
 * Deduped cross-product of `(destination, recipient, targetRouter)` scopes
 * where a standing warp quote could plausibly exist for a warp route. Each
 * protocol's reader consumes this list and queries its own storage —
 * irrelevant or empty rows are dropped silently.
 *
 * - EVM filters to `targetRouter === WARP_TARGET_ROUTER_NONE` (no CC
 *   dimension) then queries `quotes(dest, recipient)`.
 * - SVM Leaf/Routing filters to `targetRouter === WARP_TARGET_ROUTER_NONE`,
 *   derives the standing PDA per `(destination, H256::zero())`, reads the
 *   BTreeMap.
 * - SVM CrossCollateralRouting filters to `targetRouter !== WARP_TARGET_ROUTER_NONE`,
 *   derives the standing PDA per `(destination, targetRouter)`, reads the BTreeMap.
 *
 * Fully-wildcarded scopes (`destination === WILDCARD && recipient === WILDCARD`)
 * are filtered out: SVM rejects them with `FullyWildcardedQuote`; EVM never
 * resolves from that mapping slot.
 */
export function enumerateWarpQuoteCandidates(
  ctx: FeeReadContext,
): WarpQuoteScope[] {
  const candidates: WarpQuoteScope[] = [];
  const allRouters = new Set<string>();
  for (const routers of Object.values(ctx.knownRoutersPerDomain)) {
    for (const r of routers) allRouters.add(r);
  }

  for (const [domainStr, routers] of Object.entries(
    ctx.knownRoutersPerDomain,
  )) {
    const destination = Number(domainStr);
    for (const router of routers) {
      candidates.push({
        destination,
        recipient: router,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      });
      candidates.push({
        destination,
        recipient: router,
        targetRouter: router,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      });
      candidates.push({
        destination,
        recipient: WILDCARD_BYTES32,
        targetRouter: router,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      });
    }
    candidates.push({
      destination,
      recipient: WILDCARD_BYTES32,
      targetRouter: WARP_TARGET_ROUTER_NONE,
      amount: WARP_QUOTE_AMOUNT_WILDCARD,
    });
  }

  for (const router of allRouters) {
    candidates.push({
      destination: WILDCARD_DESTINATION_DOMAIN,
      recipient: router,
      targetRouter: WARP_TARGET_ROUTER_NONE,
      amount: WARP_QUOTE_AMOUNT_WILDCARD,
    });
  }

  const seen = new Map<string, WarpQuoteScope>();
  for (const c of candidates) {
    const amt =
      c.amount.kind === WarpQuoteAmountKind.wildcard
        ? 'w'
        : `v:${c.amount.value}`;
    const key = `${c.destination}|${c.recipient}|${c.targetRouter}|${amt}`;
    if (!seen.has(key)) seen.set(key, c);
  }

  return Array.from(seen.values()).filter(
    (s) =>
      !(
        s.destination === WILDCARD_DESTINATION_DOMAIN &&
        s.recipient === WILDCARD_BYTES32
      ),
  );
}
