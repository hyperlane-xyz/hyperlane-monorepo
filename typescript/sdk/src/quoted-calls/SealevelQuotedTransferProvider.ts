import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { ethers } from 'ethers';
import { bytesToHex, hexToBytes, keccak256 } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { addressToBytes32, assert, isNullish } from '@hyperlane-xyz/utils';

import { ProviderType } from '../providers/ProviderType.js';
import { IToken } from '../token/IToken.js';
import { Token } from '../token/Token.js';
import { TokenAmount } from '../token/TokenAmount.js';
import { isHypCrossCollateralAdapter } from '../token/adapters/ITokenAdapter.js';
import { SealevelHypCrossCollateralAdapter } from '../token/adapters/SealevelCrossCollateralAdapter.js';
import {
  SealevelHypTokenAdapter,
  type SealevelTransferBundle,
} from '../token/adapters/SealevelTokenAdapter.js';
import {
  SealevelSvmSignedQuote,
  buildSubmitFeeQuoteIx,
  buildSubmitIgpQuoteIx,
  deriveIgpStandingQuotePda,
  deriveIgpTransientQuotePda,
} from '../token/adapters/sealevelFee.js';
import { ChainNameOrId } from '../types.js';
import type { WarpCore } from '../warp/WarpCore.js';
import { resolveDestinationToken } from '../warp/resolveDestinationToken.js';
import { WarpTxCategory, WarpTypedTransaction } from '../warp/types.js';

import { toHex } from './assertHex.js';
import {
  FeeQuotingV2Client,
  type FeeQuotingV2IgpParams,
  type FeeQuotingV2WarpParams,
} from './client.js';
import { composeSealevelTx } from './composeSealevelTx.js';
import type { QuotedTransferProvider } from './QuotedTransferProvider.js';
import {
  type DecodedSealevelQuoteEntry,
  type DecodedSvmSignedQuote,
  decodeSealevelQuoteEntry,
} from './svmDecoder.js';

const SALT_LEN = 32;

/**
 * `keccak256(payer || clientSalt)` — mirrors the on-chain
 * `SvmSignedQuote::compute_scoped_salt` in the Rust quote-verifier.
 *
 * Duplicated from svm-sdk's `computeScopedSalt` per
 * `[no-svm-sdk-dep-in-main-sdk]`. The provider keeps the raw client salt
 * (for the API request + the signed-quote payload) and the scoped salt
 * (for the bundle PDA cascade + IGP transient PDA derivation) as
 * separate values.
 *
 * Exported for testing — not part of the package's external API surface.
 */
export function computeSealevelScopedSalt(
  payer: PublicKey,
  clientSalt: Uint8Array,
): Uint8Array {
  const combined = new Uint8Array(32 + clientSalt.length);
  combined.set(payer.toBytes(), 0);
  combined.set(clientSalt, 32);
  return hexToBytes(keccak256(combined));
}

function defaultRandomSalt(): Uint8Array {
  // ethers' isomorphic `randomBytes` works in both Node and the browser,
  // unlike `globalThis.crypto` which is undefined on Node 16 and flag-gated on
  // Node 18. Avoids a `node:crypto` import, which the SDK forbids for browser
  // safety.
  return ethers.utils.randomBytes(SALT_LEN);
}

function toSealevelSvmSignedQuote(
  decoded: DecodedSvmSignedQuote,
): SealevelSvmSignedQuote {
  return new SealevelSvmSignedQuote({
    context: decoded.context,
    data: decoded.data,
    issued_at: decoded.issuedAt,
    expiry: decoded.expiry,
    client_salt: decoded.clientSalt,
    signature: decoded.signature,
  });
}

export interface SealevelQuotedTransferProviderOpts {
  feeQuotingClient: FeeQuotingV2Client;
  connection: Connection;
  /**
   * Random-salt source — override for deterministic tests. Defaults to ethers'
   * isomorphic `randomBytes` (works in Node + browser).
   */
  randomSalt?: () => Uint8Array;
}

// ============================================================
// FeeDataStrategy decode + Linear fee math
// ============================================================
//
// `SealevelSignedQuote.data` is the Borsh encoding of the on-chain
// `FeeDataStrategy` enum: 1-byte kind + u64 LE maxFee + u64 LE halfAmount.
// Total 17 bytes. Decoded here (rather than imported from svm-sdk) per
// `[no-svm-sdk-dep-in-main-sdk]`.

const FEE_STRATEGY_BORSH_LEN = 17;
const FEE_STRATEGY_KIND_LINEAR = 0;

interface DecodedFeeStrategy {
  kind: number;
  maxFee: bigint;
  halfAmount: bigint;
}

function decodeFeeStrategy(data: Uint8Array): DecodedFeeStrategy {
  assert(
    data.length === FEE_STRATEGY_BORSH_LEN,
    `FeeDataStrategy must be ${FEE_STRATEGY_BORSH_LEN} bytes, got ${data.length}`,
  );
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    kind: dv.getUint8(0),
    maxFee: dv.getBigUint64(1, true),
    halfAmount: dv.getBigUint64(9, true),
  };
}

/**
 * Resolved fee at the given transfer amount for a Linear strategy. Formula
 * `fee = min(amount * maxFee / (2 * halfAmount), maxFee)` mirrors the
 * on-chain Linear fee program and is the inverse of `computeBps`.
 *
 * Transient quotes use this curve to encode arbitrary per-transfer fee
 * values: the server picks (maxFee, halfAmount) so the formula yields the
 * intended fee at the actual transfer amount.
 *
 * Only Linear is supported — `OffchainQuotedLinearFee` (the only strategy
 * the offchain quoter signs) is Linear by definition.
 */
function computeLinearFee(
  strategy: DecodedFeeStrategy,
  amount: bigint,
): bigint {
  assert(
    strategy.kind === FEE_STRATEGY_KIND_LINEAR,
    `Unsupported fee strategy kind ${strategy.kind}; only Linear (0) is supported`,
  );
  if (strategy.halfAmount === 0n) return 0n;
  const raw = (amount * strategy.maxFee) / (2n * strategy.halfAmount);
  return raw > strategy.maxFee ? strategy.maxFee : raw;
}

// ============================================================
// IgpQuoteData decode + gas-fee math
// ============================================================
//
// The IGP signed quote's `data` field is a different shape from the warp
// fee's `FeeDataStrategy` — it carries oracle-style price inputs that the
// on-chain `compute_gas_fee` applies to the destination's `gas_amount`
// (NOT the transfer amount). Mirrors `hyperlane-sealevel-igp/accounts.rs`'s
// `IgpQuoteData` (33 bytes) + `compute_gas_fee`.

const IGP_QUOTE_DATA_LEN = 33;
/** Matches `TOKEN_EXCHANGE_RATE_SCALE` in the on-chain IGP program (10^19). */
const TOKEN_EXCHANGE_RATE_SCALE = 10n ** 19n;
/** Native SOL decimals — the denomination of `compute_gas_fee`'s result. */
const SOL_DECIMALS = 9;
/** Max u64 — on-chain `compute_gas_fee` narrows its result with `as_u64()`. */
const U64_MAX = 2n ** 64n - 1n;

interface DecodedIgpQuoteData {
  tokenExchangeRate: bigint;
  gasPrice: bigint;
  tokenDecimals: number;
}

function decodeIgpQuoteData(data: Uint8Array): DecodedIgpQuoteData {
  assert(
    data.length === IGP_QUOTE_DATA_LEN,
    `IgpQuoteData must be ${IGP_QUOTE_DATA_LEN} bytes, got ${data.length}`,
  );
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // u128 LE = two u64 LE halves, low half first; reassemble as BigInt.
  const teLo = dv.getBigUint64(0, true);
  const teHi = dv.getBigUint64(8, true);
  const gpLo = dv.getBigUint64(16, true);
  const gpHi = dv.getBigUint64(24, true);
  return {
    tokenExchangeRate: (teHi << 64n) | teLo,
    gasPrice: (gpHi << 64n) | gpLo,
    tokenDecimals: dv.getUint8(32),
  };
}

/**
 * Mirrors on-chain `compute_gas_fee` in `hyperlane-sealevel-igp/accounts.rs`.
 * Returns the IGP payment denominated in origin native (SOL, 9 decimals).
 *
 *   dest_cost   = gas_amount * gas_price
 *   origin_cost = dest_cost * token_exchange_rate / 10^19
 *   result      = convert_decimals(origin_cost, remote_decimals → SOL_DECIMALS)
 *
 * `gasAmount` is the destination-side gas budget the warp's transferRemote
 * configures (`tokenData.destination_gas?.get(dest)`), not the transfer
 * amount. Throws if the result exceeds u64, mirroring the on-chain
 * `as_u64()` narrowing that would otherwise panic at submit.
 */
function computeIgpGasFee(
  data: DecodedIgpQuoteData,
  gasAmount: bigint,
): bigint {
  const destCost = gasAmount * data.gasPrice;
  let originCost =
    (destCost * data.tokenExchangeRate) / TOKEN_EXCHANGE_RATE_SCALE;
  if (data.tokenDecimals > SOL_DECIMALS) {
    originCost = originCost / 10n ** BigInt(data.tokenDecimals - SOL_DECIMALS);
  } else if (data.tokenDecimals < SOL_DECIMALS) {
    originCost = originCost * 10n ** BigInt(SOL_DECIMALS - data.tokenDecimals);
  }
  // On-chain `quote_gas_payment` narrows the result with `as_u64()`, which
  // panics on overflow — so a fee that doesn't fit u64 is unpayable at submit.
  // Fail the preflight here rather than display a fee the transfer can't pay.
  assert(
    originCost <= U64_MAX,
    `IGP fee ${originCost} exceeds u64; on-chain quote_gas_payment would overflow`,
  );
  return originCost;
}

/**
 * Inspect a decoded entry's envelope timestamps — the server signals a
 * transient quote with `expiry === issuedAt` (same u48 BE timestamp).
 * Standing quotes use `expiry > issuedAt`.
 *
 * The provider doesn't ask the server for a specific mode; the server's
 * config decides, and the response carries the discriminator.
 */
function isTransientQuote(entry: DecodedSealevelQuoteEntry): boolean {
  return entry.expiry === entry.issuedAt;
}

/**
 * Sealevel implementation of `QuotedTransferProvider`. Produces a single
 * atomic tx that prepends `SubmitFeeQuote` (and, when configured,
 * `SubmitIgpQuote`) ixs onto the Sealevel adapter's `transfer_remote` /
 * `transfer_remote_to` ix bundle.
 *
 * Tx layout:
 *   [...computeBudgetIxs, submitFeeQuote, submitIgpQuote?, transferRemote]
 *
 * Atomicity is required for transient mode (one-shot PDA — racy if split
 * across txs) and uniform with standing mode (one wallet confirmation).
 */
export class SealevelQuotedTransferProvider implements QuotedTransferProvider {
  readonly protocol = ProtocolType.Sealevel;

  constructor(private readonly opts: SealevelQuotedTransferProviderOpts) {}

  /**
   * Shared prep for both quote entry points. Resolves the SVM adapter + token
   * account, builds the identical warp/IGP request shapes (same salt,
   * targetRouter, recipient, and same-domain IGP gate), and fetches the warp +
   * optional IGP signed quotes in parallel. `getQuotedTransferFee` prices these
   * for display; `buildQuotedTransferTxs` composes them into submit txs —
   * keeping the derivation in one place so displayed and paid quotes can't
   * drift.
   */
  private async prepareSealevelQuote({
    warpCore,
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }) {
    const { token } = originTokenAmount;
    const destinationDomainId = warpCore.multiProvider.getDomainId(destination);
    const destinationName = warpCore.multiProvider.getChainName(destination);
    const isCC =
      destinationToken !== undefined &&
      warpCore.isCrossCollateralTransfer(token, destinationToken);

    // Defense in depth: fail early when the warp route has no fee_config. A
    // direct API caller (CLI, integration test) would otherwise quote against a
    // fee account that doesn't exist and fail later with an opaque on-chain
    // error.
    const adapter = token.getHypAdapter(
      warpCore.multiProvider,
      destinationName,
    );
    assert(
      adapter instanceof SealevelHypTokenAdapter,
      `SVM warp route requires SealevelHypTokenAdapter; got ${adapter.constructor.name}`,
    );
    const tokenData = await adapter.getTokenAccountData();
    assert(
      tokenData.fee_config,
      `Origin token on ${token.chainName} has no fee_config; offchain quoting requires a fee-enabled SVM warp route`,
    );

    // Always send a random client salt — the server's `quoteMode` config
    // decides whether the returned quote is standing (`expiry > issuedAt`) or
    // transient (`expiry === issuedAt`). Callers infer the mode from the
    // response and use the server-echoed `clientSalt` to derive the scoped salt
    // for the transient PDA cascade.
    const rawClientSalt = (this.opts.randomSalt ?? defaultRandomSalt)();
    assert(
      rawClientSalt.length === SALT_LEN,
      `rawClientSalt must be ${SALT_LEN} bytes`,
    );

    // Resolve `target_router` to mirror what the runtime CPI passes `QuoteFee`.
    // CC-to-CC routes emit `transfer_remote_to` with an explicit target router
    // (one of the destination's CC-enrolled routers, via
    // `destinationToken.addressOrDenom`); everything else auto-resolves to the
    // destination's standard enrolled remote router. Sending `ZERO` would miss
    // per-domain CC fee leaves on deployments that configure them.
    const targetRouterBytes = isCC
      ? hexToBytes(
          toHex(
            addressToBytes32(
              resolveDestinationToken({
                multiProvider: warpCore.multiProvider,
                originToken: token,
                destination,
                destinationToken,
              }).addressOrDenom,
            ),
            'targetRouter bytes32 narrowing failed',
          ),
        )
      : new Uint8Array(await adapter.getRouterAddress(destinationDomainId));

    const recipientHex = toHex(
      addressToBytes32(recipient),
      'recipient bytes32 narrowing failed',
    );
    const saltHex = bytesToHex(rawClientSalt);

    const warpReq: FeeQuotingV2WarpParams = {
      origin: token.chainName,
      router: token.addressOrDenom,
      destination: destinationDomainId,
      salt: saltHex,
      recipient: recipientHex,
      targetRouter: bytesToHex(targetRouterBytes),
      txSubmitter: sender,
    };

    // A same-domain (local) transfer consumes no interchain message and pays no
    // IGP on-chain, so skip IGP entirely: resolve the local condition first and
    // only load IGP state for remote destinations. This avoids an unused
    // IGP-state RPC on local transfers (which can itself fail on missing/bad
    // IGP accounts) and prevents prepending an orphan SubmitIgpQuote ix that
    // would strand the transient IGP quote-account rent.
    const localDomainId = warpCore.multiProvider.getDomainId(token.chainName);
    const isRemoteTransfer = destinationDomainId !== localDomainId;

    const igpProgramId = tokenData.interchain_gas_paymaster?.program_id_pubkey;
    const igpState = isRemoteTransfer
      ? await adapter.innerIgpFeeState.get()
      : undefined;
    const igpAccount = igpState?.innerIgpAccount;
    const igpEnabled =
      isRemoteTransfer &&
      !isNullish(igpProgramId) &&
      !isNullish(igpAccount) &&
      !isNullish(igpState?.feeConfig);
    const igpReq: FeeQuotingV2IgpParams | null = igpEnabled
      ? {
          origin: token.chainName,
          router: token.addressOrDenom,
          destination: destinationDomainId,
          salt: saltHex,
          txSubmitter: sender,
        }
      : null;

    // Fetch warp + (optional) IGP quotes in parallel.
    const [warpEntry, igpEntry] = await Promise.all([
      this.opts.feeQuotingClient.getWarpQuote(warpReq),
      igpReq
        ? this.opts.feeQuotingClient.getIgpQuote(igpReq)
        : Promise.resolve(null),
    ]);

    assert(
      warpEntry.protocol === ProtocolType.Sealevel,
      `Expected Sealevel warp quote, got ${warpEntry.protocol}`,
    );
    const decodedWarp = decodeSealevelQuoteEntry(warpEntry);

    return {
      token,
      adapter,
      tokenData,
      // Narrowed by the assert above; surfaced so callers needn't re-assert.
      feeConfig: tokenData.fee_config,
      destinationDomainId,
      isCC,
      targetRouterBytes,
      igpState,
      igpProgramId,
      igpAccount,
      igpEntry,
      decodedWarp,
    };
  }

  /**
   * Display-time fee fetch. Hits the offchain quoter for warp (+ optional
   * IGP) signed quotes, decodes each `data` as a `FeeDataStrategy`, and
   * applies the Linear formula at `originTokenAmount.amount` to produce the
   * priced tuple. Standalone from `buildQuotedTransferTxs` — the submit path
   * re-fetches independently rather than reusing display state.
   *
   * `tokenFeeQuote.token` is the bridged token (matches what the on-chain
   * fee program charges); `igpQuote.token` is the origin chain's native
   * (SOL on Solana mainnet).
   */
  async getQuotedTransferFee({
    warpCore,
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }): Promise<{
    igpQuote: TokenAmount<IToken>;
    tokenFeeQuote?: TokenAmount<IToken>;
  }> {
    const {
      token,
      adapter,
      tokenData,
      destinationDomainId,
      igpState,
      igpEntry,
      decodedWarp,
    } = await this.prepareSealevelQuote({
      warpCore,
      originTokenAmount,
      destination,
      sender,
      recipient,
      destinationToken,
    });

    const warpStrategy = decodeFeeStrategy(decodedWarp.signedQuote.data);
    const tokenFeeAmount = computeLinearFee(
      warpStrategy,
      originTokenAmount.amount,
    );
    const tokenFeeQuote =
      tokenFeeAmount > 0n ? new TokenAmount(tokenFeeAmount, token) : undefined;

    const nativeToken = Token.FromChainMetadataNativeToken(
      warpCore.multiProvider.getChainMetadata(token.chainName),
    );
    const gasAmountRaw = tokenData.destination_gas?.get(destinationDomainId);
    let igpFeeAmount = 0n;
    if (igpEntry) {
      assert(
        igpEntry.protocol === ProtocolType.Sealevel,
        `Expected Sealevel IGP quote, got ${igpEntry.protocol}`,
      );
      const decodedIgp = decodeSealevelQuoteEntry(igpEntry);
      const igpData = decodeIgpQuoteData(decodedIgp.signedQuote.data);
      // `destination_gas` is the per-destination gas budget the warp route
      // configures; this is what `transferRemote` will pay for at submit
      // time. The chain's `HyperlaneGasRouterDispatch::dispatch_with_gas`
      // unwraps it with `ok_or(InvalidArgument)`, so an unset entry means
      // the transfer would fail at submit — display must surface that
      // rather than silently reporting 0.
      // For OverheadIgp configs, the chain adds the per-destination overhead
      // before pricing (`OverheadIgp::quote_gas_payment`), so mirror that
      // here to match the submitted fee.
      assert(
        !isNullish(gasAmountRaw),
        `Warp route has no destination_gas configured for domain ${destinationDomainId}; transfer would fail at submit`,
      );
      // borsh@0.7 decodes these u64 map values as bn.js `BN`, not the `bigint`
      // the types claim, so normalize before arithmetic: `BN + bigint`
      // string-concatenates (silent corruption) and `BN * bigint` throws.
      const gasBudget = BigInt(gasAmountRaw.toString());
      const overheadGas = BigInt(
        (igpState?.gasOverheads?.get(destinationDomainId) ?? 0n).toString(),
      );
      igpFeeAmount = computeIgpGasFee(igpData, gasBudget + overheadGas);
    } else if (!isNullish(igpState) && !isNullish(gasAmountRaw)) {
      // Legacy IGP route (no offchain `fee_config`, so no signed IGP quote):
      // the submit path falls back to on-chain `quoteGasPayment`, so mirror it
      // rather than displaying 0. Pass the raw destination gas — an OverheadIgp
      // applies its overhead on-chain, exactly as the submit path relies on.
      igpFeeAmount = await adapter.quoteLegacyIgpGasPayment(
        destinationDomainId,
        BigInt(gasAmountRaw.toString()),
        new PublicKey(sender),
      );
    }
    const igpQuote = new TokenAmount(igpFeeAmount, nativeToken);

    return { igpQuote, tokenFeeQuote };
  }

  async buildQuotedTransferTxs({
    warpCore,
    originTokenAmount,
    destination,
    sender,
    recipient,
    destinationToken,
  }: {
    warpCore: WarpCore;
    originTokenAmount: TokenAmount<IToken>;
    destination: ChainNameOrId;
    sender: string;
    recipient: string;
    destinationToken?: IToken;
  }): Promise<Array<WarpTypedTransaction>> {
    const {
      token,
      adapter,
      feeConfig,
      destinationDomainId,
      isCC,
      targetRouterBytes,
      igpProgramId,
      igpAccount,
      igpEntry,
      decodedWarp,
    } = await this.prepareSealevelQuote({
      warpCore,
      originTokenAmount,
      destination,
      sender,
      recipient,
      destinationToken,
    });
    const senderPubkey = new PublicKey(sender);

    // 5. Derive the bundle/cascade scopedSalt from the warp response.
    //    Transient → keccak256(payer || serverEchoedClientSalt); Standing →
    //    undefined (cascade returns the standing path only). When IGP is
    //    enabled, assert its mode matches — server-config divergence between
    //    the two endpoints would silently break PDA lookups.
    const warpIsTransient = isTransientQuote(decodedWarp);
    const scopedSalt = warpIsTransient
      ? computeSealevelScopedSalt(
          senderPubkey,
          decodedWarp.signedQuote.clientSalt,
        )
      : undefined;

    // Extract the EFFECTIVE target_router the server signed for. CC fee leaves
    // produce a 76B context whose trailing 32B is `ctx.target_router`; the
    // server may resolve it to `DEFAULT_ROUTER` when the request's target
    // router has no specific leaf configured. The on-chain `SubmitQuote`
    // handler verifies the route PDA at `cc_route_pda_seeds!(fee_account,
    // dest, ctx.target_router)` literally — no DEFAULT_ROUTER fallback at
    // submit time — so the SDK must mirror the server's resolution. Leaf /
    // non-CC contexts are 44B and carry no target_router slot; fall back to
    // the request's bytes (kept ZERO by the cascade layout's standing-target
    // hardcode at `_ => H256::zero()`).
    const LEAF_CONTEXT_LEN = 44;
    const CC_CONTEXT_LEN = 76;
    const contextLen = decodedWarp.signedQuote.context.length;
    assert(
      contextLen === LEAF_CONTEXT_LEN || contextLen === CC_CONTEXT_LEN,
      `Unexpected signed-quote context length ${contextLen}; expected ${LEAF_CONTEXT_LEN} (leaf/non-CC) or ${CC_CONTEXT_LEN} (cross-collateral)`,
    );
    const effectiveTargetRouter =
      contextLen === CC_CONTEXT_LEN
        ? decodedWarp.signedQuote.context.slice(LEAF_CONTEXT_LEN)
        : targetRouterBytes;

    const submitFeeIx = await buildSubmitFeeQuoteIx({
      connection: this.opts.connection,
      feeProgramId: feeConfig.feeProgram,
      feeAccount: feeConfig.feeAccount,
      payer: senderPubkey,
      signedQuote: toSealevelSvmSignedQuote(decodedWarp.signedQuote),
      scopedSalt,
      destinationDomain: destinationDomainId,
      targetRouter: effectiveTargetRouter,
    });

    let submitIgpIx: TransactionInstruction | undefined;
    if (igpEntry) {
      assert(
        igpEntry.protocol === ProtocolType.Sealevel,
        `Expected Sealevel IGP quote, got ${igpEntry.protocol}`,
      );
      const decodedIgp = decodeSealevelQuoteEntry(igpEntry);
      assert(
        isTransientQuote(decodedIgp) === warpIsTransient,
        'Warp and IGP quote modes diverge — server config inconsistency. Same scopedSalt drives both cascades.',
      );
      // IGP standing PDA seeds carry `(igp, fee_token_mint, dest, sender)`;
      // SOL-paying routes use `Pubkey::default` for `fee_token_mint`, and the
      // sender is the warp router program ID.
      assert(igpProgramId && igpAccount, 'igpProgramId/igpAccount required');
      const quotePda = scopedSalt
        ? deriveIgpTransientQuotePda(igpProgramId, igpAccount, scopedSalt)
        : deriveIgpStandingQuotePda(
            igpProgramId,
            igpAccount,
            // SOL-paying routes only — the IGP standing PDA seeds include
            // `fee_token_mint`, which is `Pubkey::default()` for native SOL
            // payment. SPL-paying IGPs aren't supported by this provider
            // today; revisit when the on-chain IGP enables offchain
            // submission for non-native fee tokens.
            PublicKey.default,
            destinationDomainId,
            new PublicKey(token.addressOrDenom),
          );
      submitIgpIx = buildSubmitIgpQuoteIx({
        igpProgramId,
        igpAccount,
        payer: senderPubkey,
        quotePda,
        signedQuote: toSealevelSvmSignedQuote(decodedIgp.signedQuote),
      });
    }

    // 6. Pull the adapter ix bundle (CC or non-CC).
    let bundle: SealevelTransferBundle;
    if (isCC) {
      assert(
        adapter instanceof SealevelHypCrossCollateralAdapter &&
          isHypCrossCollateralAdapter(adapter),
        'Cross-collateral SVM route requires SealevelHypCrossCollateralAdapter',
      );
      const resolved = resolveDestinationToken({
        multiProvider: warpCore.multiProvider,
        originToken: token,
        destination,
        destinationToken,
      });
      assert(
        resolved.addressOrDenom,
        'Destination token missing addressOrDenom',
      );
      bundle = await adapter.getTransferRemoteToIxBundle({
        amount: originTokenAmount.amount.toString(),
        destination: destinationDomainId,
        recipient,
        targetRouter: resolved.addressOrDenom,
        fromAccountOwner: sender,
        scopedSalt,
      });
    } else {
      bundle = await adapter.getTransferRemoteIxBundle({
        weiAmountOrId: originTokenAmount.amount.toString(),
        destination: destinationDomainId,
        recipient,
        fromAccountOwner: sender,
        scopedSalt,
      });
    }

    // 7. Compose single atomic tx — budget head, submit prelude, then warp.
    const prelude: TransactionInstruction[] = [submitFeeIx];
    if (submitIgpIx) prelude.push(submitIgpIx);
    const tx = await composeSealevelTx({
      connection: this.opts.connection,
      instructions: [
        ...bundle.computeBudgetInstructions,
        ...prelude,
        ...bundle.transferInstructions,
      ],
      addressLookupTableAccounts: bundle.addressLookupTableAccounts,
      feePayer: bundle.feePayer,
      signers: bundle.signers,
    });

    return [
      {
        category: WarpTxCategory.Transfer,
        type: ProviderType.SolanaWeb3,
        transaction: tx,
        extraSigners: bundle.signers,
      },
    ];
  }
}
