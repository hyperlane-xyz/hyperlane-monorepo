import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem';

import { ProtocolType } from '@hyperlane-xyz/provider-sdk';
import { addressToBytes32, assert, isNullish } from '@hyperlane-xyz/utils';

import { ProviderType } from '../providers/ProviderType.js';
import { IToken } from '../token/IToken.js';
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
  const salt = new Uint8Array(SALT_LEN);
  globalThis.crypto.getRandomValues(salt);
  return salt;
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
   * Random-salt source — override for deterministic tests. Defaults to
   * `crypto.getRandomValues` (works in Node + browser).
   */
  randomSalt?: () => Uint8Array;
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
    const senderPubkey = new PublicKey(sender);
    const { token } = originTokenAmount;
    const destinationDomainId = warpCore.multiProvider.getDomainId(destination);
    const destinationName = warpCore.multiProvider.getChainName(destination);

    const isCC =
      destinationToken !== undefined &&
      warpCore.isCrossCollateralTransfer(token, destinationToken);

    // Defense in depth: fail early when the warp route has no fee_config.
    // The UI hook (`useSvmQuotedTransfer`) is supposed to gate provider
    // construction on this, but a direct API caller (CLI, integration test)
    // would otherwise build a SubmitFeeQuote ix against a fee account that
    // doesn't exist and fail later with an opaque on-chain error.
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

    // 1. Always send a random client salt — the server's `quoteMode` config
    //    decides whether the returned quote is standing (`expiry > issuedAt`)
    //    or transient (`expiry === issuedAt`). The provider infers mode from
    //    the response and uses the server-echoed `clientSalt` to derive the
    //    scoped salt (for transient PDA cascade lookup).
    const rawClientSalt = (this.opts.randomSalt ?? defaultRandomSalt)();
    assert(
      rawClientSalt.length === SALT_LEN,
      `rawClientSalt must be ${SALT_LEN} bytes`,
    );

    // 2. Resolve `target_router` to mirror what the runtime CPI will pass
    //    `QuoteFee`. For CC-to-CC routes the bundle emits `transfer_remote_to`
    //    and the CC ix payload carries an explicit `target_router` chosen by
    //    the user (one of the destination's CC-enrolled routers, resolved via
    //    `destinationToken.addressOrDenom`). For everything else the base
    //    `transfer_remote` auto-resolves to the destination's standard
    //    enrolled remote router (`tokenData.remote_routers[dest]`, exposed
    //    via `getRouterAddress`). Sending `ZERO` here would miss per-domain
    //    CC fee leaves on deployments that configure them.
    const targetRouterBytes = isCC
      ? hexToBytes(
          addressToBytes32(
            resolveDestinationToken({
              multiProvider: warpCore.multiProvider,
              originToken: token,
              destination,
              destinationToken,
            }).addressOrDenom,
          ) as Hex,
        )
      : new Uint8Array(await adapter.getRouterAddress(destinationDomainId));

    // 3. Build API request shape — same salt/txSubmitter for both endpoints.
    const recipientHex = addressToBytes32(recipient) as Hex;
    const targetRouterHex = bytesToHex(targetRouterBytes);
    const saltHex = bytesToHex(rawClientSalt);

    const warpReq: FeeQuotingV2WarpParams = {
      origin: token.chainName,
      router: token.addressOrDenom,
      destination: destinationDomainId,
      salt: saltHex,
      recipient: recipientHex,
      targetRouter: targetRouterHex,
      txSubmitter: sender,
    };

    const igpState = await adapter.innerIgpFeeState.get();
    const igpProgramId = tokenData.interchain_gas_paymaster?.program_id_pubkey;
    const igpAccount = igpState?.innerIgpAccount;
    const igpEnabled =
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

    // 4. Fetch warp + (optional) IGP quotes in parallel.
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
    const CC_CONTEXT_LEN = 76;
    const effectiveTargetRouter =
      decodedWarp.signedQuote.context.length === CC_CONTEXT_LEN
        ? decodedWarp.signedQuote.context.slice(44)
        : targetRouterBytes;

    const submitFeeIx = await buildSubmitFeeQuoteIx({
      connection: this.opts.connection,
      feeProgramId: tokenData.fee_config.feeProgram,
      feeAccount: tokenData.fee_config.feeAccount,
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
