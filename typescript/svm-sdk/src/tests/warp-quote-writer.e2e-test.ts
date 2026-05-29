import { secp256k1 } from '@noble/curves/secp256k1';
import { address as parseAddress } from '@solana/kit';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';
import { before, describe, it } from 'mocha';

import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
  WarpQuoteAmountKind,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { decodeStandingQuotePda } from '../accounts/fee.js';
import { SvmSigner } from '../clients/signer.js';
import { SvmOffchainQuotedLinearFeeWriter } from '../fee/offchain-quoted-linear-fee.js';
import { DEFAULT_FEE_SALT, type SvmFeeWriterConfig } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { deriveStandingQuotePda } from '../pda.js';
import { ethAddressHexFromPrivateKey } from '../quote-signing.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

import { SvmPrivateKeyQuoteSigner } from '../quote/SvmPrivateKeyQuoteSigner.js';
import { SvmQuoteArtifactManager } from '../quote/SvmQuoteArtifactManager.js';

chai.use(chaiAsPromised);

const TX_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const ROUTER = '0x' + 'aa'.repeat(32);

// Custom-program error codes the on-chain fee program returns via
// `ProgramError::Custom(N)`. Asserting on the exact decimal lets failure tests
// pin the error path that actually fired instead of accepting any rejection.
const ERROR_UNAUTHORIZED_SIGNER = 3705418912; // QuoteVerifyError::UnauthorizedSigner

describe('SVM Warp Quote Writer E2E', function () {
  this.timeout(180_000);

  const writerConfig: SvmFeeWriterConfig = {
    program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
  };

  let rpc: ReturnType<typeof createRpc>;
  let txSigner: SvmSigner;
  let quoteSignerPk: Uint8Array;
  let quoteSignerAddress: string;
  let feeProgramId: string;
  let feeAccountPda: string;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    txSigner = await SvmSigner.connectWithSigner(
      [TEST_SVM_CHAIN_METADATA.rpcUrl],
      TX_PRIVATE_KEY,
    );
    await airdropSol(
      rpc,
      parseAddress(txSigner.getSignerAddress()),
      100_000_000_000n,
    );

    quoteSignerPk = secp256k1.utils.randomSecretKey();
    quoteSignerAddress = ethAddressHexFromPrivateKey(quoteSignerPk);

    const feeWriter = new SvmOffchainQuotedLinearFeeWriter(
      writerConfig,
      rpc,
      TEST_SVM_CHAIN_METADATA.domainId,
      txSigner,
      DEFAULT_FEE_SALT,
    );
    const [deployed] = await feeWriter.create({
      config: {
        type: FeeType.offchainQuotedLinear,
        owner: txSigner.getSignerAddress(),
        beneficiary: txSigner.getSignerAddress(),
        params: {
          type: FeeParamsType.raw,
          maxFee: '1000',
          halfAmount: '1000000',
        },
        quoteSigners: [quoteSignerAddress],
      },
    });
    feeProgramId = deployed.deployed.programId;
    feeAccountPda = deployed.deployed.feeAccountPda;
  });

  function makeWriter(pk: Uint8Array = quoteSignerPk) {
    return new SvmQuoteArtifactManager(
      txSigner,
      {
        feeProgramId,
        feeAccountPda,
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      { knownRoutersPerDomain: {} },
    ).createWriter(new SvmPrivateKeyQuoteSigner(pk));
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  it('submits a standing quote and stores it on-chain', async () => {
    const writer = makeWriter();
    const destDomain = 137;
    const issuedAt = nowSec();
    const expiry = issuedAt + 3600;
    const targetRouterBytes = new Uint8Array(32);

    await writer.submitQuote({
      scope: {
        destination: destDomain,
        recipient: ROUTER,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 4_321n, halfAmount: 8_765n },
      issuedAt,
      expiry,
    });

    const standingPda = await deriveStandingQuotePda(
      parseAddress(feeProgramId),
      parseAddress(feeAccountPda),
      destDomain,
      targetRouterBytes,
    );
    const acct = await rpc
      .getAccountInfo(parseAddress(standingPda.address), { encoding: 'base64' })
      .send();
    assert(acct.value, 'standing PDA should be initialized after submit');
    const decoded = decodeStandingQuotePda(
      Uint8Array.from(Buffer.from(acct.value.data[0], 'base64')),
    );
    assert(decoded, 'standing PDA should decode');
    const entry = decoded.quotes.get(ROUTER);
    assert(entry, 'standing entry for ROUTER recipient should exist');
    expect(entry.issuedAt).to.equal(BigInt(issuedAt));
    expect(entry.expiry).to.equal(BigInt(expiry));
  });

  it('submits a transient quote and returns the tx hash + signature', async () => {
    const writer = makeWriter();
    const ts = nowSec() + 1;
    const result = await writer.submitQuote({
      scope: {
        destination: 137,
        recipient: ROUTER,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: { kind: WarpQuoteAmountKind.value, value: 1_000n },
      },
      params: { maxFee: 42n, halfAmount: 84n },
      issuedAt: ts,
      expiry: ts,
    });
    expect(result.txHash).to.be.a('string').and.not.equal('');
    expect(result.signature).to.match(/^0x[0-9a-f]{130}$/);
  });

  it('rejects standing quotes with a non-wildcard amount (client-side check)', async () => {
    const writer = makeWriter();
    const issuedAt = nowSec() + 2;
    await expect(
      writer.submitQuote({
        scope: {
          destination: 137,
          recipient: ROUTER,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: { kind: WarpQuoteAmountKind.value, value: 42n },
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt,
        expiry: issuedAt + 3600,
      }),
    ).to.be.rejectedWith(/Standing quotes must use wildcard amount/);
  });

  it(`rejects when the quote signer is not in the on-chain signer set (Custom ${ERROR_UNAUTHORIZED_SIGNER})`, async () => {
    const otherPk = secp256k1.utils.randomSecretKey();
    const writer = makeWriter(otherPk);
    const issuedAt = nowSec() + 3;
    const error = await writer
      .submitQuote({
        scope: {
          destination: 137,
          recipient: ROUTER,
          targetRouter: WARP_TARGET_ROUTER_NONE,
          amount: WARP_QUOTE_AMOUNT_WILDCARD,
        },
        params: { maxFee: 1n, halfAmount: 2n },
        issuedAt,
        expiry: issuedAt + 3600,
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert(error, 'submitQuote should have rejected');
    const serialized = JSON.stringify(error, (_k, v) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(serialized).to.include(String(ERROR_UNAUTHORIZED_SIGNER));
  });
});
