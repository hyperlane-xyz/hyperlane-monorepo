import { randomBytes } from '@noble/hashes/utils';
import { address as parseAddress } from '@solana/kit';

import {
  type CreateWarpQuoteRequest,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
  type SubmittedWarpQuote,
  WARP_TARGET_ROUTER_NONE,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert, fromHexString, toHexString } from '@hyperlane-xyz/utils';

import type { SvmSigner } from '../clients/signer.js';
import { u48be } from '../codecs/binary.js';
import {
  type SvmSignedQuote,
  WILDCARD_AMOUNT,
  encodeFeeDataStrategy,
  encodeSvmFeeQuoteContext,
} from '../codecs/fee.js';
import { FeeStrategyKind } from '../fee/types.js';
import {
  getSubmitQuoteInstruction,
  simulateSubmitQuoteAccountMetas,
} from '../instructions/fee.js';
import { deriveFeeAccountPda } from '../pda.js';
import { computeScopedSalt } from '../quote-signing.js';

import { type SvmQuoteSignable } from './SvmQuoteSignable.js';

const CLIENT_SALT_LEN = 32;

export interface SvmQuoteWriterConfig {
  feeProgramId: string;
  salt: Uint8Array;
  domainId: number;
}

/**
 * Submits offchain-signed warp quotes to a deployed SVM fee program via
 * `SubmitQuote`. Composes the protocol-specific `context` / `data` bytes
 * from a cross-VM `CreateWarpQuoteRequest`, builds the signable digest
 * envelope the SVM signer expects, runs `simulateSubmitQuoteAccountMetas`
 * to assemble the account list (transient or standing) and sends the
 * resulting `SubmitQuote` instruction via the bound `SvmSigner`.
 */
export class SvmQuoteWriter implements IRawWarpQuoteWriter {
  constructor(
    private readonly txSigner: SvmSigner,
    private readonly quoteSigner: RawQuoteSigner,
    private readonly config: SvmQuoteWriterConfig,
  ) {}

  async submitQuote(req: CreateWarpQuoteRequest): Promise<SubmittedWarpQuote> {
    if (req.expiry > req.issuedAt) {
      assert(
        req.scope.amount.kind === WarpQuoteAmountKind.wildcard,
        'Standing quotes must use wildcard amount (SVM rejects non-wildcard).',
      );
    }

    const recipientBytes = Uint8Array.from(fromHexString(req.scope.recipient));
    const targetRouterIsNone =
      req.scope.targetRouter === WARP_TARGET_ROUTER_NONE;
    const targetRouterBytes = targetRouterIsNone
      ? undefined
      : Uint8Array.from(fromHexString(req.scope.targetRouter));

    const amount =
      req.scope.amount.kind === WarpQuoteAmountKind.wildcard
        ? WILDCARD_AMOUNT
        : req.scope.amount.value;

    const context = Uint8Array.from(
      encodeSvmFeeQuoteContext({
        destinationDomain: req.scope.destination,
        recipient: recipientBytes,
        amount,
        targetRouter: targetRouterBytes,
      }),
    );

    const data = Uint8Array.from(
      encodeFeeDataStrategy({
        kind: FeeStrategyKind.Linear,
        params: {
          maxFee: req.params.maxFee,
          halfAmount: req.params.halfAmount,
        },
      }),
    );

    const clientSalt = randomBytes(CLIENT_SALT_LEN);
    const payerAddress = this.txSigner.getSignerAddress();
    const scopedSalt = computeScopedSalt(
      parseAddress(payerAddress),
      clientSalt,
    );

    const programId = parseAddress(this.config.feeProgramId);
    const feeAccountPda = await deriveFeeAccountPda(
      programId,
      this.config.salt,
    );

    const signable: SvmQuoteSignable = {
      feeAccount: feeAccountPda.address,
      domainId: this.config.domainId,
      context,
      data,
      issuedAt: req.issuedAt,
      expiry: req.expiry,
      scopedSalt,
    };
    const { signature } = await this.quoteSigner.sign(signable);

    const signedQuote: SvmSignedQuote = {
      context,
      data,
      issuedAt: u48be(BigInt(req.issuedAt)),
      expiry: u48be(BigInt(req.expiry)),
      clientSalt,
      signature,
    };

    const isTransient = req.expiry === req.issuedAt;
    const payer = parseAddress(payerAddress);

    const accounts = await simulateSubmitQuoteAccountMetas({
      rpc: this.txSigner.getRpc(),
      programId,
      feeAccount: feeAccountPda.address,
      payer,
      input: {
        destinationDomain: req.scope.destination,
        targetRouter: targetRouterBytes ?? new Uint8Array(32),
        scopedSalt: isTransient ? scopedSalt : undefined,
      },
      payerSubstitution: payer,
    });

    const ix = getSubmitQuoteInstruction(programId, accounts, signedQuote);
    const receipt = await this.txSigner.send({
      instructions: [ix],
      skipPreflight: false,
    });

    return {
      txHash: receipt.signature,
      signature: toHexString(Buffer.from(signature)),
    };
  }
}
