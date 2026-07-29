import { type Signer, utils as ethersUtils } from 'ethers';

import { OffchainQuotedLinearFee__factory } from '@hyperlane-xyz/core';
import {
  type CreateWarpQuoteRequest,
  type IRawWarpQuoteWriter,
  type RawQuoteSigner,
  type SubmittedWarpQuote,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import {
  buildEvmSignedQuoteSignable,
  buildEvmSignedQuoteTuple,
} from './WarpSignedQuoteEip712.js';

/**
 * Submits offchain-signed warp quotes to a deployed `OffchainQuotedLinearFee`.
 * Pre-flights the quote signer's authorization on-chain (`isQuoteSigner`) and
 * binds the EIP-712 `submitter` field to the tx-submitter's address so only
 * the configured tx signer may broadcast the resulting payload.
 */
export class EvmQuoteWriter implements IRawWarpQuoteWriter {
  constructor(
    private readonly txSigner: Signer,
    private readonly quoteSigner: RawQuoteSigner,
    private readonly feeAddress: string,
  ) {}

  async submitQuote(req: CreateWarpQuoteRequest): Promise<SubmittedWarpQuote> {
    if (req.expiry > req.issuedAt) {
      assert(
        req.scope.amount.kind === WarpQuoteAmountKind.wildcard,
        'Standing quotes must use wildcard amount (EVM rejects non-wildcard).',
      );
    }

    const contract = OffchainQuotedLinearFee__factory.connect(
      this.feeAddress,
      this.txSigner,
    );

    const quoteSignerAddress = await this.quoteSigner.address();
    const isAuthorized = await contract.isQuoteSigner(quoteSignerAddress);
    assert(
      isAuthorized,
      `Quote signer ${quoteSignerAddress} is not authorized on OffchainQuotedLinearFee at ${this.feeAddress}.`,
    );

    const chainId = await this.txSigner.getChainId();
    const submitter = await this.txSigner.getAddress();
    const salt = ethersUtils.hexlify(ethersUtils.randomBytes(32));

    const sq = buildEvmSignedQuoteTuple(req, salt, submitter);
    const signable = buildEvmSignedQuoteSignable(sq, chainId, this.feeAddress);
    const { signature } = await this.quoteSigner.sign(signable);
    const signatureHex = ethersUtils.hexlify(signature);

    const tx = await contract.submitQuote(sq, signatureHex);
    const receipt = await tx.wait();

    // A standing quote emits QuoteSubmitted only when actually stored; a
    // resubmission with an equal-or-older issuedAt is a silent on-chain no-op.
    // Surface that so callers don't report success for an ignored update.
    // Transient quotes (expiry === issuedAt) never emit the event and don't
    // persist, so the flag is left undefined for them.
    const standingStored =
      req.expiry > req.issuedAt
        ? receipt.logs.some(
            (entry) =>
              entry.address.toLowerCase() === this.feeAddress.toLowerCase() &&
              entry.topics[0] ===
                contract.interface.getEventTopic('QuoteSubmitted'),
          )
        : undefined;

    return {
      txHash: receipt.transactionHash,
      signature: signatureHex,
      standingStored,
    };
  }
}
