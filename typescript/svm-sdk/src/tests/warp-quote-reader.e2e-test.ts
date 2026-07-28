import { secp256k1 } from '@noble/curves/secp256k1';
import { address as parseAddress } from '@solana/kit';
import { expect } from 'chai';
import { before, describe, it } from 'mocha';

import { FeeParamsType, FeeType } from '@hyperlane-xyz/provider-sdk/fee';
import {
  WARP_QUOTE_AMOUNT_WILDCARD,
  WARP_TARGET_ROUTER_NONE,
} from '@hyperlane-xyz/provider-sdk/quote';
import { assert } from '@hyperlane-xyz/utils';

import { SvmSigner } from '../clients/signer.js';
import { SvmOffchainQuotedLinearFeeWriter } from '../fee/offchain-quoted-linear-fee.js';
import { DEFAULT_FEE_SALT, type SvmFeeWriterConfig } from '../fee/types.js';
import { HYPERLANE_SVM_PROGRAM_BYTES } from '../hyperlane/program-bytes.js';
import { ethAddressHexFromPrivateKey } from '../quote-signing.js';
import { createRpc } from '../rpc.js';
import { TEST_SVM_CHAIN_METADATA } from '../testing/constants.js';
import { airdropSol } from '../testing/setup.js';

import { SvmPrivateKeyQuoteSigner } from '../quote/SvmPrivateKeyQuoteSigner.js';
import { SvmQuoteArtifactManager } from '../quote/SvmQuoteArtifactManager.js';

const TX_PRIVATE_KEY =
  '0x0000000000000000000000000000000000000000000000000000000000000001';

const ROUTER_A = '0x' + 'aa'.repeat(32);
const ROUTER_B = '0x' + 'bb'.repeat(32);

describe('SVM Warp Quote Reader E2E', function () {
  this.timeout(180_000);

  const writerConfig: SvmFeeWriterConfig = {
    program: { programBytes: HYPERLANE_SVM_PROGRAM_BYTES.tokenFee },
  };

  let rpc: ReturnType<typeof createRpc>;
  let txSigner: SvmSigner;
  let quoteSignerPk: Uint8Array;
  let feeProgramId: string;

  before(async () => {
    rpc = createRpc(TEST_SVM_CHAIN_METADATA.rpcUrl);
    txSigner = await SvmSigner.connectWithSigner(
      TEST_SVM_CHAIN_METADATA,
      TX_PRIVATE_KEY,
    );
    await airdropSol(
      rpc,
      parseAddress(txSigner.getSignerAddress()),
      100_000_000_000n,
    );

    quoteSignerPk = secp256k1.utils.randomSecretKey();
    const quoteSignerAddress = ethAddressHexFromPrivateKey(quoteSignerPk);

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
  });

  function makeManager(knownRoutersPerDomain: Record<number, Set<string>>) {
    return new SvmQuoteArtifactManager(
      rpc,
      {
        feeProgramId,
        salt: DEFAULT_FEE_SALT,
        domainId: TEST_SVM_CHAIN_METADATA.domainId,
      },
      { knownRoutersPerDomain },
    );
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
  }

  it('returns no entries before any quote is submitted', async () => {
    const reader = makeManager({ 137: new Set([ROUTER_A]) }).createReader();
    expect(await reader.readStandingQuotes()).to.deep.equal([]);
  });

  it('reads back a standing quote submitted via the writer', async () => {
    const destDomain = 137;
    const manager = makeManager({ [destDomain]: new Set([ROUTER_A]) });
    const writer = manager.createWriter(
      new SvmPrivateKeyQuoteSigner(quoteSignerPk),
      txSigner,
    );
    const issuedAt = nowSec();
    const expiry = issuedAt + 3600;
    await writer.submitQuote({
      scope: {
        destination: destDomain,
        recipient: ROUTER_A,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 4_321n, halfAmount: 8_765n },
      issuedAt,
      expiry,
    });

    const entries = await manager.createReader().readStandingQuotes();
    const match = entries.find(
      (e) =>
        e.scope.destination === destDomain && e.scope.recipient === ROUTER_A,
    );
    assert(match, 'reader should surface the standing entry just submitted');
    expect(match.scope.targetRouter).to.equal(WARP_TARGET_ROUTER_NONE);
    expect(match.params.maxFee).to.equal(4_321n);
    expect(match.params.halfAmount).to.equal(8_765n);
    expect(match.issuedAt).to.equal(issuedAt);
    expect(match.expiry).to.equal(expiry);
  });

  it('reads back multiple recipients across multiple domains in one pass', async () => {
    const dest1 = 1;
    const dest2 = 10;
    const manager = makeManager({
      [dest1]: new Set([ROUTER_A]),
      [dest2]: new Set([ROUTER_B]),
    });
    const writer = manager.createWriter(
      new SvmPrivateKeyQuoteSigner(quoteSignerPk),
      txSigner,
    );
    const issuedAt = nowSec() + 4;
    const expiry = issuedAt + 3600;

    await writer.submitQuote({
      scope: {
        destination: dest1,
        recipient: ROUTER_A,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 11n, halfAmount: 22n },
      issuedAt,
      expiry,
    });
    await writer.submitQuote({
      scope: {
        destination: dest2,
        recipient: ROUTER_B,
        targetRouter: WARP_TARGET_ROUTER_NONE,
        amount: WARP_QUOTE_AMOUNT_WILDCARD,
      },
      params: { maxFee: 33n, halfAmount: 44n },
      issuedAt,
      expiry,
    });

    const entries = await manager.createReader().readStandingQuotes();
    const found = new Set(
      entries.map((e) => `${e.scope.destination}|${e.scope.recipient}`),
    );
    expect(found.has(`${dest1}|${ROUTER_A}`)).to.equal(true);
    expect(found.has(`${dest2}|${ROUTER_B}`)).to.equal(true);
  });
});
