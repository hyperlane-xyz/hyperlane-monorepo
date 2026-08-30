import { type Signer, constants, utils as ethersUtils } from 'ethers';

import { OffchainQuotedPiecewiseLinearFee__factory } from '@hyperlane-xyz/core';
import {
  type RawQuoteSigner,
  type SubmittedWarpQuote,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import {
  type CreateEvmPiecewiseWarpQuoteRequest,
  type EvmPiecewiseStoredStandingCurve,
  encodeEvmPiecewiseStandingQuoteData,
  validateEvmPiecewiseStandingCurve,
} from './EvmPiecewiseQuote.js';
import {
  type EvmSignedQuoteTuple,
  buildEvmSignedQuoteSignable,
} from './WarpSignedQuoteEip712.js';

const UINT32_MAX = 0xff_ff_ff_ff;
const UINT48_MAX = 2 ** 48 - 1;

function assertUint48(value: number, label: string): void {
  assert(
    Number.isInteger(value) && value >= 0 && value <= UINT48_MAX,
    `${label} must be a uint48.`,
  );
}

/**
 * Submits persistent piecewise warp-fee quotes to EVM. The writer binds each
 * signature to its tx submitter, waits for finality, and exposes raw stored
 * curve readback without requiring consumers to import the core ABI package.
 */
export class EvmPiecewiseQuoteWriter {
  constructor(
    private readonly txSigner: Signer,
    private readonly quoteSigner: RawQuoteSigner,
    private readonly feeAddress: string,
  ) {}

  async submitQuote(
    req: CreateEvmPiecewiseWarpQuoteRequest,
  ): Promise<SubmittedWarpQuote> {
    assertUint48(req.issuedAt, 'issuedAt');
    assertUint48(req.expiry, 'expiry');
    assert(
      req.expiry > req.issuedAt,
      'EVM piecewise quotes must be standing quotes with expiry greater than issuedAt.',
    );
    assert(
      Number.isInteger(req.scope.destination) &&
        req.scope.destination >= 0 &&
        req.scope.destination <= UINT32_MAX,
      'scope.destination must be a uint32.',
    );
    assert(
      ethersUtils.isHexString(req.scope.recipient, 32),
      'scope.recipient must be a bytes32 hex string.',
    );
    assert(
      req.scope.amount.kind === WarpQuoteAmountKind.wildcard,
      'EVM piecewise standing quotes must use wildcard amount.',
    );
    assert(
      req.issuedAt + req.curve.staleAfterSeconds <= req.expiry,
      'staleAfterSeconds must elapse no later than expiry.',
    );

    const contract = OffchainQuotedPiecewiseLinearFee__factory.connect(
      this.feeAddress,
      this.txSigner,
    );
    const quoteSignerAddress = await this.quoteSigner.address();
    const [isAuthorized, maxBands] = await Promise.all([
      contract.isQuoteSigner(quoteSignerAddress),
      contract.maxBands(),
    ]);
    assert(
      isAuthorized,
      `Quote signer ${quoteSignerAddress} is not authorized on OffchainQuotedPiecewiseLinearFee at ${this.feeAddress}.`,
    );
    validateEvmPiecewiseStandingCurve(req.curve, maxBands);

    const chainId = await this.txSigner.getChainId();
    const submitter = await this.txSigner.getAddress();
    const salt = ethersUtils.hexlify(ethersUtils.randomBytes(32));
    const sq: EvmSignedQuoteTuple = {
      context: ethersUtils.solidityPack(
        ['uint32', 'bytes32', 'uint256'],
        [req.scope.destination, req.scope.recipient, constants.MaxUint256],
      ),
      data: encodeEvmPiecewiseStandingQuoteData(req.curve),
      issuedAt: req.issuedAt,
      expiry: req.expiry,
      salt,
      submitter,
    };
    const signable = buildEvmSignedQuoteSignable(sq, chainId, this.feeAddress);
    const { signature } = await this.quoteSigner.sign(signable);
    const signatureHex = ethersUtils.hexlify(signature);

    const tx = await contract.submitQuote(sq, signatureHex);
    const receipt = await tx.wait();
    const standingStored = receipt.logs.some(
      (entry) =>
        entry.address.toLowerCase() === this.feeAddress.toLowerCase() &&
        entry.topics[0] === contract.interface.getEventTopic('QuoteSubmitted'),
    );

    return {
      txHash: receipt.transactionHash,
      signature: signatureHex,
      standingStored,
    };
  }

  async readStandingCurve(
    destination: number,
    recipient: string,
  ): Promise<EvmPiecewiseStoredStandingCurve> {
    assert(
      Number.isInteger(destination) &&
        destination >= 0 &&
        destination <= UINT32_MAX,
      'destination must be a uint32.',
    );
    assert(
      ethersUtils.isHexString(recipient, 32),
      'recipient must be a bytes32 hex string.',
    );

    const contract = OffchainQuotedPiecewiseLinearFee__factory.connect(
      this.feeAddress,
      this.txSigner,
    );
    const stored = await contract.getCurve(destination, recipient);
    return {
      exists: stored.expiry !== 0,
      breakpoints: stored.breakpoints.map((value) => value.toBigInt()),
      marginalBpsX1e4: [...stored.marginalBpsX1e4],
      staleAfterSeconds: stored.staleAfterSeconds,
      staleMarginalSurchargeBpsX1e4: [...stored.staleMarginalSurchargeBpsX1e4],
      issuedAt: stored.issuedAt,
      expiry: stored.expiry,
    };
  }
}
