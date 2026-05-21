import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { type Hex, bytesToHex, hexToBytes, keccak256 } from 'viem';

import { ProtocolType, addressToBytes32, assert } from '@hyperlane-xyz/utils';

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
  type DecodedSvmSignedQuote,
  decodeSealevelQuoteEntry,
} from './svmDecoder.js';

export type SealevelQuoteMode = 'standing' | 'transient';

const SALT_LEN = 32;
const ZERO_SALT = new Uint8Array(SALT_LEN);

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
  /**
   * `'standing'` uses ZERO_BYTES32 as the salt and lets the server pick a
   * long-lived standing-quote PDA. `'transient'` generates a fresh random
   * client salt + scoped salt for a one-shot transient PDA — the same scoped
   * salt threads into the adapter bundle so the on-chain cascade includes
   * the transient PDA.
   */
  mode: SealevelQuoteMode;
  connection: Connection;
  feeProgramId: PublicKey;
  feeAccount: PublicKey;
  /**
   * Omit until SVM IGP supports `SubmitIgpQuote` on-chain. When set, provider
   * fetches a parallel IGP quote and prepends a second submit ix before the
   * transfer ix.
   */
  igpProgramId?: PublicKey;
  igpAccount?: PublicKey;
  /**
   * Random-salt source — override for deterministic tests. Defaults to
   * `crypto.getRandomValues` (works in Node + browser).
   */
  randomSalt?: () => Uint8Array;
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

    // 1. Resolve salts.
    //    standing  -> rawClientSalt = ZERO_BYTES32, scopedSalt = undefined
    //    transient -> rawClientSalt = random,      scopedSalt = keccak256(payer||raw)
    const rawClientSalt =
      this.opts.mode === 'transient'
        ? (this.opts.randomSalt ?? defaultRandomSalt)()
        : ZERO_SALT;
    assert(
      rawClientSalt.length === SALT_LEN,
      `rawClientSalt must be ${SALT_LEN} bytes`,
    );
    const scopedSalt =
      this.opts.mode === 'transient'
        ? computeSealevelScopedSalt(senderPubkey, rawClientSalt)
        : undefined;

    // 2. Resolve targetRouter bytes — CC uses the destination router's
    //    H256; non-CC uses H256::zero (matches the on-chain fee program's
    //    seed macro for Leaf / Routing modes).
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
      : new Uint8Array(SALT_LEN);

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

    const igpEnabled = !!(this.opts.igpProgramId && this.opts.igpAccount);
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

    const submitFeeIx = await buildSubmitFeeQuoteIx({
      connection: this.opts.connection,
      feeProgramId: this.opts.feeProgramId,
      feeAccount: this.opts.feeAccount,
      payer: senderPubkey,
      signedQuote: toSealevelSvmSignedQuote(decodedWarp.signedQuote),
      scopedSalt,
      destinationDomain: destinationDomainId,
      targetRouter: targetRouterBytes,
    });

    let submitIgpIx: TransactionInstruction | undefined;
    if (igpEntry) {
      assert(
        igpEntry.protocol === ProtocolType.Sealevel,
        `Expected Sealevel IGP quote, got ${igpEntry.protocol}`,
      );
      const decodedIgp = decodeSealevelQuoteEntry(igpEntry);
      // IGP standing PDA seeds carry `(igp, fee_token_mint, dest, sender)`;
      // SOL-paying routes use `Pubkey::default` for `fee_token_mint`, and the
      // sender is the warp router program ID.
      const quotePda = scopedSalt
        ? deriveIgpTransientQuotePda(
            this.opts.igpProgramId!,
            this.opts.igpAccount!,
            scopedSalt,
          )
        : deriveIgpStandingQuotePda(
            this.opts.igpProgramId!,
            this.opts.igpAccount!,
            PublicKey.default,
            destinationDomainId,
            new PublicKey(token.addressOrDenom),
          );
      submitIgpIx = buildSubmitIgpQuoteIx({
        igpProgramId: this.opts.igpProgramId!,
        igpAccount: this.opts.igpAccount!,
        payer: senderPubkey,
        quotePda,
        signedQuote: toSealevelSvmSignedQuote(decodedIgp.signedQuote),
      });
    }

    // 5. Pull the adapter ix bundle (CC or non-CC).
    const adapter = token.getHypAdapter(
      warpCore.multiProvider,
      destinationName,
    );
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
        clientSalt: scopedSalt,
      });
    } else {
      assert(
        adapter instanceof SealevelHypTokenAdapter,
        'SVM warp route requires SealevelHypTokenAdapter',
      );
      bundle = await adapter.getTransferRemoteIxBundle({
        weiAmountOrId: originTokenAmount.amount.toString(),
        destination: destinationDomainId,
        recipient,
        fromAccountOwner: sender,
        clientSalt: scopedSalt,
      });
    }

    // 6. Compose single atomic tx — budget head, submit prelude, then warp.
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
      },
    ];
  }
}
